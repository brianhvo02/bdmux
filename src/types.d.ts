type Directory = Record<string, File>;

interface RootDirectory {
  name: string;
  directory: Directory;
}

interface GetFolderResult {
  error?: string;
  folder?: RootDirectory;
}

interface Playitem {
  clipId: string;
  inTime: number;
  outTime: number;
}

interface Playmark {
  markType: number;
  playItemRef: number;
  time: number;
}

interface Playlist {
  playitems: Playitem[];
  playmarks: Playmark[]
}

interface Chapter {
  clipId: string;
  time: number;
}

interface PlaylistChapter {
  name: string;
  time: string;
}

interface PlaylistInfo {
  filenameStr: string;
  durationStr: string;
  durationNum: number;
  chaptersNum: number;
  chapters: Chapter[];
  playlist: Playlist;
}

interface VideoStream {
  codingType: number;
  format: number;
  rate: number;
  aspect: number;
}

interface AudioStream {
  codingType: number;
  format: number;
  rate: number;
  lang: string;
}

interface GraphicsStream {
  codingType: number;
  lang: string;
}

interface SubtitleStream {
  codingType: number;
  charCode: number;
  lang: string;
}

type StreamInfo = VideoStream | AudioStream | GraphicsStream | SubtitleStream;
type StreamMap = Record<number, StreamInfo>;