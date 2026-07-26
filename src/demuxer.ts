import { EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, Output, StreamTarget, type AudioCodec } from 'mediabunny';

enum StreamType {
  VIDEO_H264 = 0x1B,
  VIDEO_H265 = 0x24,
  AUDIO_PCM = 0x80,
  AUDIO_DOLBY_DIGITAL,
  AUDIO_DTS_6CH,
  AUDIO_DOLBY_TRUEHD,
  AUDIO_DOLBY_DIGITAL_PLUS,
  AUDIO_DTS_8CH,
  AUDIO_DTS_8CH_LOSSLESS,
  PRESENTATION_GRAPHIC = 0x90,
};

const BITS_PER_SAMPLE = [0, 16, 20, 24];
export enum ChannelLayouts {
  MONO = 1, STEREO = 3, SURROUND,
  LAYOUT_2_1, LAYOUT_4_0, LAYOUT_2_2,
  LAYOUT_5_0, LAYOUT_5_1, LAYOUT_7_0,
  LAYOUT_7_1,
}

const VIDEO_RATES = [ 0, 23.976, 24, 25, 29.97, 0, 50, 59.94 ];

const SAMPLE_RATES = [null, 48000, null, null, 96000, 192000];

// const valueToHex = function(value: number, byteCount: number) {
//   return '0x' + value.toString(16).padStart(byteCount * 2, '0').toUpperCase();
// }

export default class Demuxer {
  private chunksMap: Record<number, Uint8Array<ArrayBuffer>[]> = {};

  private file: File;
  private streamMap: StreamMap;
  private streamArr: StreamInfoWithPid[];
  private streamSet = new Set<number>();
  // private fileHandleMap: Record<number, FileSystemSyncAccessHandle> = {};
  private sourceMap: Record<number, EncodedVideoPacketSource | EncodedAudioPacketSource> = {};
  private output: Output;
  private backlogMap: Record<number, EncodedPacket[]> = {};
  private inTime: number;

  size: number;
  progress = 0;

  constructor(
    file: File, programs: StreamObj[], inTime: number,
    writeStream: WritableStream,
  ) {
    this.file = file;
    this.size = file.size;
    this.streamMap = programs[0].map;
    this.streamArr = programs[0].arr;
    this.inTime = inTime;

    this.output = new Output({
      format: new MkvOutputFormat(),
      target: new StreamTarget(writeStream),
      onFinalize() {
        console.log('file written!');
      }
    });;

    this.streamArr.forEach(s => {
      this.chunksMap[s.pid] = [];
      this.streamSet.add(s.pid);
    });
  }

  async parsePacket(pid: number) {
    const packet = new Uint8Array(this.chunksMap[pid].reduce((total, arr) => total + arr.length, 0));
    const packetView = new DataView(packet.buffer);
    this.chunksMap[pid].reduce((idx, chunk) => {
      packet.set(chunk, idx);
      return idx + chunk.length;
    }, 0);

    if (packet[0] !== 0x00 || packet[1] !== 0x00 || packet[2] !== 0x01) {
      console.log('Invalid packet start code (0x000001).');
      return;
    }

    const header = packetView.getUint16(6);
    const ptsDtsIndicator = (header & 0xC0) >> 6;
    const pts = Boolean(ptsDtsIndicator & 0b10);
    // const dts = Boolean(ptsDtsIndicator & 0b01);
    const headerLength = packetView.getUint8(8);
    
    const timestamp = pts ? Number(
      (BigInt(packet[9]) & 0x0En) << 30n |
      (BigInt(packetView.getUint16(10)) & 0xFFFEn) << 15n |
      (BigInt(packetView.getUint16(12)) & 0xFFFEn)
    ) : null;

    if (!timestamp) {
      console.error('No PTS in PES packet.');
      return;
    }

    const ts = (timestamp - this.inTime * 4) / 180000;
    const data = packet.slice(9 + headerLength);

    switch (this.streamMap[pid].codingType) {
      case StreamType.VIDEO_H264: {
        const streamInfo = this.streamMap[pid] as VideoStream;

        const frameRate = streamInfo.rate === 1
          ? 24000/1001
          : streamInfo.rate === 4
            ? 30000/1001
            : streamInfo.rate === 7
              ? 60000/1001
              : VIDEO_RATES[streamInfo.rate];

        if (!this.sourceMap[pid]) {
          const init = this.streamArr.slice(0, this.streamMap[pid].idx)
            .every(s => this.sourceMap[s.pid]);

          if (init) {
            this.sourceMap[pid] = new EncodedVideoPacketSource('avc');
            this.output.addVideoTrack(this.sourceMap[pid], { frameRate });
          }
        }

        const source = this.sourceMap[pid] as EncodedVideoPacketSource;

        const packet = new EncodedPacket(
          data, data[5] === 0x10 ? 'key' : 'delta', 
          ts, 1 / frameRate,
        );

        const config = {
          decoderConfig: {
            codec: 'avc1.640029',
            codedHeight: streamInfo.format === 8 ? 3840 : 1920,
            codedWidth: streamInfo.format === 8 ? 2160 : 1080,
          }
        };

        this.backlogMap[pid] ??= [];
        if (this.output.state === 'started') {
          if (this.backlogMap[pid].length) {
            this.backlogMap[pid].map(packet => source.add(packet, config));
            this.backlogMap[pid].length = 0;
          } else {
            source.add(packet, config);
          }
        } else {
          this.backlogMap[pid].push(packet);
        }

        if (this.output.state === 'pending' &&
          Object.keys(this.sourceMap).length === Object.keys(this.streamMap).length
        ) await this.output.start();

        break;
      }
      case StreamType.AUDIO_PCM: {
        const pcmHeader = data.slice(0, 4);
        const audio = data.slice(4);

        const channelLayout = pcmHeader[2] >> 4;
        const numberOfChannels = channelLayout === ChannelLayouts.MONO
          ? 1 : channelLayout === ChannelLayouts.STEREO
          ? 2 : null;
        if (!numberOfChannels) {
          console.error('Only mono and stereo PCM currently supported.');
          return;
        }
        const sampleRate = SAMPLE_RATES[pcmHeader[2] & 0x0F] ?? 0;
        const bitsPerSample = BITS_PER_SAMPLE[pcmHeader[3] >> 6];
        const bytesPerSample = bitsPerSample / 8;
        
        if ((bitsPerSample !== 24 && bitsPerSample !== 16) || sampleRate === 0) {
          console.error('PCM audio other than 16 or 24 bits not supported.');
          return;
        }

        const streamInfo = this.streamMap[pid] as AudioStream;

        if (!this.sourceMap[pid]) {
          const init = this.streamArr.slice(0, this.streamMap[pid].idx)
            .every(s => this.sourceMap[s.pid]);

          if (init) {
            this.sourceMap[pid] = new EncodedAudioPacketSource(
              `pcm-s${bitsPerSample}be` as AudioCodec
            );
            this.output.addAudioTrack(this.sourceMap[pid], { languageCode: streamInfo.lang });
          }
        }

        const source = this.sourceMap[pid] as EncodedAudioPacketSource;

        const packet = new EncodedPacket(
          audio, 'key', ts, 
          audio.byteLength / (sampleRate * numberOfChannels * bytesPerSample),
        );

        const config = {
          decoderConfig: {
            codec: 'pcm-s' + bitsPerSample,
            numberOfChannels, sampleRate,
          }
        };

        this.backlogMap[pid] ??= [];
        if (this.output.state === 'started') {
          if (this.backlogMap[pid].length) {
            this.backlogMap[pid].map(packet => source.add(packet, config));
            this.backlogMap[pid].length = 0;
          } else {
            source.add(packet, config);
          }
        } else {
          this.backlogMap[pid].push(packet);
        }

        if (this.output.state === 'pending' &&
          Object.keys(this.sourceMap).length === Object.keys(this.streamMap).length
        ) await this.output.start();

        break;
      }
      case StreamType.PRESENTATION_GRAPHIC: {
        
      }
    }

    this.chunksMap[pid].length = 0;
  }

  async demux() {
    let reader = this.file.stream().getReader();
    let leftovers = new Uint8Array();

    while (true) {
      const { done, value } = await reader.read();

      if (done)
        break;

      this.progress += value.byteLength;

      const currentData = new Uint8Array(leftovers.length + value.length);
      currentData.set(leftovers);
      currentData.set(value, leftovers.length);
      const numPackets = Math.floor(currentData.length / 192);
      for (let i = 0; i < numPackets; i++) {
        const packet = new Uint8Array(currentData.buffer.slice(i * 192, (i + 1) * 192));
        const view = new DataView(packet.buffer);

        const syncByte = view.getUint8(4);

        if (syncByte !== 0x47)
          console.error('Packet not in sync.');

        const valIdx5 = view.getUint16(5);
        const payloadUnitStartIndicator = Boolean(valIdx5 & 0x4000);
        const pid = valIdx5 & 0x1FFF;

        if (!this.streamSet.has(pid))
          continue;

        const valIdx7 = view.getUint8(7);
        const adaptationFieldControl = (valIdx7 & 0x30) >> 4;

        const payloadStart = ((adaptationFieldControl & 0b10) ? view.getUint8(8) + 1 : 0) + 8;
        
        if (payloadUnitStartIndicator && this.chunksMap[pid].length) {
          await this.parsePacket(pid);
        }

        this.chunksMap[pid].push(packet.slice(payloadStart));
      }

      leftovers = currentData.slice(numPackets * 192);
    }

    for (const spid of Object.keys(this.chunksMap)) {
      const pid = parseInt(spid);
      if (this.chunksMap[pid].length)
        await this.parsePacket(pid);
      this.sourceMap[pid].close();
    }

    console.log('done');
    return this.output.finalize();
  }
}