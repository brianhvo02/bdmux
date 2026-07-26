import './App.css';
import { ChevronRight } from '@mui/icons-material';
import { Alert, Box, Button, CircularProgress, Input, List, ListItem, ListItemButton, ListItemIcon, ListItemText, ListSubheader } from '@mui/material';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { convertSecondsToTimestamp } from './utils.ts';

const demuxWorker = new ComlinkWorker<
  typeof import('./workers/demuxer.ts')
>(new URL('./workers/demuxer.ts', import.meta.url), {
  name: 'demuxerComlink',
  type: 'module',
});

const getFolder = async function(): Promise<GetFolderResult> {
  const inputEl = document.createElement('input');
  inputEl.type = 'file';
  inputEl.webkitdirectory = true;

  const files = await new Promise<FileList | null>(resolve => {
    inputEl.onchange = () => resolve(inputEl.files);
    inputEl.oncancel = () => resolve(null);
    inputEl.click();
  });

  if (!files)
    return { error: 'No folder selected.' };

  const directory: Directory = {};
  for (const file of files)
    directory[file.webkitRelativePath] = file;

  const path = files.item(0)?.webkitRelativePath;
  const name = path?.slice(0, path.indexOf('/'));
  
  if (!name)
    return { error: 'No folder selected.' };

  if (!directory[name + '/BDMV/index.bdmv'])
    return { error: 'Not a Blu-ray disc.' };

  return { folder: { name, directory } };
}

export default function App() {
  const [error, setError] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const [chapters, setChapters] = useState<PlaylistChapter[]>([]);
  const [processing, setProcessing] = useState(false);
  const [rootDirectory, setRootDirectory] = useState<RootDirectory | null>(null);
  const { data: playlists } = useQuery<PlaylistInfo[]>({
    queryKey: ['initialize'],
    queryFn: rootDirectory 
      ? async () => demuxWorker.initialize(rootDirectory)
      : skipToken,
    staleTime: Infinity,
  });
  const { data } = useQuery({
    queryKey: ['getPlaylist', playlist?.filenameStr],
    queryFn: playlist && processing 
      ? async () => demuxWorker.processPlaylist(playlist.playlist, chapters)
      : skipToken,
    staleTime: Infinity,
  });

  const url = useMemo(() => data && URL.createObjectURL(data), [data]);

  const selectFolder = useCallback(async () => {
    const { error, folder } = await getFolder();
    if (error) setError(error);
    if (folder) {
      setError('');
      setRootDirectory(folder);
      setMessage('Loaded ' + folder.name);
      setPlaylist(null);
      setChapters([]);
      setProcessing(false);
    };
  }, []);

  return (
    <Box component='main' sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '1rem',
      gap: '1rem',
    }}>
      <Button variant='contained' onClick={selectFolder}>
        Select folder
      </Button>
      { (error || message) &&
      <Alert severity={message ? 'success' : 'error'}>
        { message || error }
      </Alert> }
      { playlists && !playlist &&
      <List
        component='nav'
        subheader={
          <ListSubheader component='div'>
            Select a playlist:
          </ListSubheader>
        }
      >
        { playlists.map(info => 
        <ListItem key={info.filenameStr}>
          <ListItemButton onClick={() => {
            setPlaylist(info);
            setChapters(info.chapters.map(({ time }) => ({ 
              time: convertSecondsToTimestamp(time), name: ''
            })));
          }}>
            <ListItemIcon>
              <ChevronRight />
            </ListItemIcon>
            {info.filenameStr} {
              info.durationStr.slice(0, info.durationStr.indexOf('.'))
            } [{info.chaptersNum} chapters]
          </ListItemButton>
        </ListItem>) }
      </List> }
      { playlist && !processing &&
      <Button onClick={() => setProcessing(true)}>
        Save
      </Button> }
      { playlist && !processing &&
      <List
        component='nav'
        subheader={
          <ListSubheader component='div'>
            Edit chapters
          </ListSubheader>
        }
      >
        { chapters.map((chapter, i) => 
        <ListItem
          key={`${playlist.filenameStr}-${chapter.time}`} 
          sx={{ display: 'flex', gap: '1rem' }}
        >
          <ListItemText>{chapter.time}</ListItemText>
          <Input type='text' value={chapter.name}
            onChange={e => setChapters(prev => [
              ...prev.slice(0, i),
              { time: prev[i].time, name: e.target.value },
              ...prev.slice(i + 1),
            ])}
          />
        </ListItem>) }
      </List> }
      { processing && !url &&
      <CircularProgress /> }
      {url && <video src={url} controls/>}
    </Box>
  );
}