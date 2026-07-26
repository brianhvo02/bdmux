import Demuxer from '../demuxer';
import { convertSecondsToTimestamp } from '../utils';

let root: RootDirectory;

const strToUint32 = function(str: string) {
  if (str.length !== 4)
    throw new Error('String not of length 4.');

  return str.split('')
    .reduce((val, c, i) => val | c.charCodeAt(0) << ((3 - i) * 8), 0);
}

const readString = function(view: DataView, startIdx: number, length: number) {
  return Array.from(Array(length).keys()).reduce(
    (str, i) => str + String.fromCharCode(view.getUint8(startIdx + i)), 
    ''
  );
}

const MPLS_SIG1 = strToUint32('MPLS');
const CLPI_SIG1 = strToUint32('HDMV');

const BDMV_VERSION_0100 = strToUint32('0100');
const BDMV_VERSION_0200 = strToUint32('0200');
const BDMV_VERSION_0240 = strToUint32('0240');
const BDMV_VERSION_0300 = strToUint32('0300');

const BDMV_VERSIONS = [
  BDMV_VERSION_0100, BDMV_VERSION_0200, BDMV_VERSION_0240, BDMV_VERSION_0300
];

const getFilesInDirectory = function(path: string) {
  return Object.values(root.directory)
    .filter(f => f.webkitRelativePath.indexOf(root.name + path) === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const bdmvParseHeader = function(buf: ArrayBuffer) {
  const view = new DataView(buf, 0, 8);
  const tag = view.getUint32(0);
  const ver = view.getUint32(4);

  return { tag, ver }; 
}

const readPlaylist = function(buf: ArrayBuffer) {
  // Verify header
  const { tag, ver } = bdmvParseHeader(buf);
  if (tag !== MPLS_SIG1 || !BDMV_VERSIONS.includes(ver))
    throw new Error('File not a MPLS playlist.');

  const headerView = new DataView(buf, 8, 16);
  const listPos = headerView.getUint32(0);
  const markPos = headerView.getUint32(4);

  const plView = new DataView(buf, listPos + 6, 10);
  const listCount = plView.getUint16(0);
  // const subCount = plView.getUint16(2);

  const playitems = [];
  let idx = listPos + 10;
  for (let i = 0; i < listCount; i++) {
    const piLenView = new DataView(buf, idx, 2);
    const piLen = piLenView.getUint16(0);
    const playitemView = new DataView(buf, idx + 2, piLen);

    const clipId = readString(playitemView, 0, 5);
    const codecId = readString(playitemView, 5, 4);

    if (codecId === 'FMTS')
      throw new Error('FMTS file not supported.');
    if (codecId !== 'M2TS')
      throw new Error('Incorrect CodecIdentifier.');

    // const isMultiAngle = playitemView.getUint8(10) & 0x10;
    // const angleCount = isMultiAngle ? playitemView.getUint8(24) : 1

    // const stcId = playitemView.getUint8(11);
    const inTime = playitemView.getUint32(12);
    const outTime = playitemView.getUint32(16);
    // const stnStart = idx + 38 + isMultiAngle * 2 + (angleCount - 1) * 10;
    // const stnView = new DataView(buf, stnStart);
    // const numVideo = stnView.getUint8(0);
    // const numAudio = stnView.getUint8(1);
    // const numPg = stnView.getUint8(2);
    
    // let strIdx = 12;
    // for (let j = 0; j < numVideo; j++) {

    // }

    playitems.push({ clipId, inTime, outTime });

    idx += piLen + 2;
  }

  const pmView = new DataView(buf, markPos + 4, 10);
  const markCount = pmView.getUint16(0);

  const playmarks = [];
  for (let i = 0; i < markCount; i++) {
    const playmarkView = new DataView(buf, markPos + 6 + (i * 14), 14);

    playmarks.push({
      markType: playmarkView.getUint8(1),
      playItemRef: playmarkView.getUint16(2),
      time: playmarkView.getUint32(4),
      // entryEsPid: playmarkView.getUint16(8),
      // duration: playmarkView.getUint32(10),
    });
  }

  return { playitems, playmarks };
}

const readClip = function(buf: ArrayBuffer) {
  // Verify header
  const { tag, ver } = bdmvParseHeader(buf);
  if (tag !== CLPI_SIG1 || !BDMV_VERSIONS.includes(ver))
    throw new Error('File not a CLPI clip info.');

  const headerView = new DataView(buf, 8, 28);
  // const sequenceInfoStartAddr = headerView.getUint32(0);
  const programInfoStartAddr = headerView.getUint32(4);
  // const cpiStartAddr = headerView.getUint32(8);
  // const clipMarkStartAddr = headerView.getUint32(12);
  // const extDataStartAddr = headerView.getUint32(16);
  const piView = new DataView(buf, programInfoStartAddr + 5);
  const numProgs = piView.getUint8(0);

  let idx = programInfoStartAddr + 6;
  const programs: StreamObj[] = [];
  for (let i = 0; i < numProgs; i++) {
    const programView = new DataView(buf, idx);
    const numStreams = programView.getUint8(6);
    programs[i] = { arr: [], map: {} };
    idx += 8;
    for (let j = 0; j < numStreams; j++) {
      const streamView = new DataView(buf, idx);
      const pid = streamView.getUint16(0);
      const len = streamView.getUint8(2);
      const codingType = streamView.getUint8(3);
      switch (codingType) {
        case 0x01:
        case 0x02:
        case 0xea:
        case 0x1b:
        case 0x20:
        case 0x24: {
          const b1 = streamView.getUint8(4);
          const format = (b1 & 0xF0) >> 4;
          const rate = b1 & 0x0F;
          const aspect = (streamView.getUint8(5) & 0xF0) >> 4;
          const obj = { codingType, format, rate, aspect };
          programs[i].map[pid] = { idx: j, ...obj };
          programs[i].arr.push({ pid, ...obj });
          break;
        }

        case 0x03:
        case 0x04:
        case 0x80:
        case 0x81:
        case 0x82:
        case 0x83:
        case 0x84:
        case 0x85:
        case 0x86:
        case 0xa1:
        case 0xa2: {
          const b1 = streamView.getUint8(4);
          const format = (b1 & 0xF0) >> 4;
          const rate = b1 & 0x0F;
          const lang = readString(streamView, 5, 3);
          const obj = { codingType, format, rate, lang };
          programs[i].map[pid] = { idx: j, ...obj };
          programs[i].arr.push({ pid, ...obj });
          break;
        }

        case 0x90:
        case 0x91:
        case 0xa0: {
          const lang = readString(streamView, 4, 3);
          const obj = { codingType, lang };
          programs[i].map[pid] = { idx: j, ...obj };
          programs[i].arr.push({ pid, ...obj });
          break;
        }

        case 0x92: {
          const charCode = streamView.getUint8(4);
          const lang = readString(streamView, 5, 3);
          const obj = { codingType, charCode, lang };
          programs[i].map[pid] = { idx: j, ...obj };
          programs[i].arr.push({ pid, ...obj });
          break;
        }

        default:
          console.error('unrecognized coding type:', codingType)
          break;
      };
      
      idx += len + 3;
    }
  }

  return programs;
}

export const initialize = async function(rootDir: RootDirectory) {
  root = rootDir;

  const playlists = await Promise.all(
    getFilesInDirectory('/BDMV/PLAYLIST')
      .map(async file => 
        file.arrayBuffer()
          .then(buf => ({ name: file.name, ...readPlaylist(buf)}))
      )
  );

  return playlists.map(playlist => {
    const totalSeconds = playlist.playitems.reduce(
      (sum, pi) => sum + (pi.outTime - pi.inTime) / 45000, 0
    );

    const chapters = playlist.playmarks.map(mark => {
      const elapsed = mark.playItemRef && playlist.playitems
        .slice(0, mark.playItemRef)
        .reduce((t, pi) => t + (pi.outTime - pi.inTime) / 45000, 0);
      const playitem = playlist.playitems[mark.playItemRef];
      const markTime = mark.time - playitem.inTime;
      const time = elapsed + markTime / 45000;

      return { clipId: playitem.clipId, time };
    }, []);

    return {
      filenameStr: playlist.name,
      durationStr: convertSecondsToTimestamp(totalSeconds),
      durationNum: totalSeconds,
      chaptersNum: playlist.playmarks.length,
      chapters,
      playlist: {
        playitems: playlist.playitems,
        playmarks: playlist.playmarks,
      },
    };
  }).sort((a, b) => b.durationNum - a.durationNum);
}

export const processPlaylist = async function(
  playlist: Playlist, chapters: PlaylistChapter[]
) {
  const clipInfo = await Promise.all(
    playlist.playitems.map(async ({ clipId }) => {
      const clipInfoFile = root.directory[
        `${root.name}/BDMV/CLIPINF/${clipId}.clpi`
      ];

      return clipInfoFile.arrayBuffer()
        .then(buf => ({ [clipId]: readClip(buf).flat() }));
    })
  ).then(info => info.reduce((map, i) => ({ ...map, ...i }), {}));

  const playitem = playlist.playitems[0];
  
  const opfs = await navigator.storage.getDirectory();
  const fh = await opfs.getFileHandle(
    `${playitem.clipId}.mkv`, { create: true }
  );
  const ws = await fh.createWritable();
  
  const demuxer = new Demuxer(root.directory[
    `${root.name}/BDMV/STREAM/${playitem.clipId}.m2ts`
  ], clipInfo[playitem.clipId], playitem.inTime, ws);

  await demuxer.demux();

  return fh.getFile();
}