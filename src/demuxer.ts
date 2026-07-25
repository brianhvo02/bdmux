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

const SAMPLE_RATES = [null, 48000, null, null, 96000, 192000];

// const valueToHex = function(value: number, byteCount: number) {
//   return '0x' + value.toString(16).padStart(byteCount * 2, '0').toUpperCase();
// }

export default class Demuxer {
  private chunksMap: Record<number, Uint8Array<ArrayBuffer>[]> = {};

  private file: File;
  private streamMap: StreamMap;
  private streamSet = new Set<number>();
  private fileHandleMap: Record<number, FileSystemSyncAccessHandle> = {};

  constructor(file: File, programs: StreamMap[]) {
    this.file = file;
    this.streamMap = programs[0];
    Object.keys(this.streamMap)
      .forEach(s => {
        const pid = Number(s);
        this.chunksMap[pid] = [];
        this.streamSet.add(pid);
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

    const headerLength = packetView.getUint8(8);

    const data = packet.slice(9 + headerLength);

    switch (this.streamMap[pid].codingType) {
      case StreamType.VIDEO_H264: {
        if (!this.fileHandleMap[pid]) {
          const opfs = await navigator.storage.getDirectory();
          const fh = await opfs.getFileHandle(`${pid}.h264`, { create: true });
          this.fileHandleMap[pid] = await fh.createSyncAccessHandle();
        }
        this.fileHandleMap[pid].write(
          data, { at: this.fileHandleMap[pid].getSize() }
        );
        this.fileHandleMap[pid].flush();
        break;
      }
      case StreamType.AUDIO_PCM: {
        const pcmHeader = data.slice(0, 4);
        const audio = data.slice(4);

        const channelLayout = pcmHeader[2] >> 4;
        const numOfChannels = channelLayout === ChannelLayouts.MONO
          ? 1 : channelLayout === ChannelLayouts.STEREO
          ? 2 : null;
        if (!numOfChannels) {
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

        if (!this.fileHandleMap[pid]) {
          const opfs = await navigator.storage.getDirectory();
          const fh = await opfs.getFileHandle(`${pid}.wav`, { create: true });
          this.fileHandleMap[pid] = await fh.createSyncAccessHandle();
          const header = new ArrayBuffer(44);
          const headerUint8 = new Uint8Array(header);
          const headerView = new DataView(header);
  
          const textEncoder = new TextEncoder();
          textEncoder.encodeInto('RIFF', headerUint8);
          textEncoder.encodeInto('WAVE', headerUint8.subarray(8));
          textEncoder.encodeInto('fmt ', headerUint8.subarray(12));
          headerView.setUint32(16, 16, true);
          headerView.setUint16(20, 1, true);
          headerView.setUint16(22, numOfChannels, true);
          headerView.setUint32(24, sampleRate, true);
          headerView.setUint32(28, sampleRate * numOfChannels * bytesPerSample, true);
          headerView.setUint16(32, numOfChannels * bytesPerSample, true);
          headerView.setUint16(34, bitsPerSample, true);
          textEncoder.encodeInto('data', headerUint8.subarray(36));
          
          this.fileHandleMap[pid].write(header);
          this.fileHandleMap[pid].flush();
        }

        for (let i = 0; i < audio.byteLength / bytesPerSample; i++) {
          const oppIdx = (i + 1) * bytesPerSample - 1;
          const byte = audio[oppIdx];
          audio[oppIdx] = audio[i * bytesPerSample];
          audio[i * bytesPerSample] = byte;
        }

        this.fileHandleMap[pid].write(
          audio, { at: this.fileHandleMap[pid].getSize() }
        );
        this.fileHandleMap[pid].flush();

        break;
      }
      case StreamType.PRESENTATION_GRAPHIC: {
        if (!this.fileHandleMap[pid]) {
          const opfs = await navigator.storage.getDirectory();
          const fh = await opfs.getFileHandle(`${pid}.sup`, { create: true });
          this.fileHandleMap[pid] = await fh.createSyncAccessHandle();
        }
        this.fileHandleMap[pid].write(
          data, { at: this.fileHandleMap[pid].getSize() }
        );
        this.fileHandleMap[pid].flush();
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
      if (this.streamMap[pid].codingType === StreamType.AUDIO_PCM) {
        const chunkLength = new ArrayBuffer(4);
        new DataView(chunkLength).setUint32(
          0, this.fileHandleMap[pid].getSize() - 8
        );
        this.fileHandleMap[pid].write(chunkLength, { at: 4 });
        new DataView(chunkLength).setUint32(
          0, this.fileHandleMap[pid].getSize() - 8
        );

        const subchunkLength = new ArrayBuffer(4);
        new DataView(subchunkLength).setUint32(
          0, this.fileHandleMap[pid].getSize() - 44
        );
        this.fileHandleMap[pid].write(subchunkLength, { at: 0x28 });
        new DataView(subchunkLength).setUint32(
          0, this.fileHandleMap[pid].getSize() - 8
        );

        this.fileHandleMap[pid].flush();
      }

      this.fileHandleMap[pid].close();
    }

    console.log('done');
  }
}