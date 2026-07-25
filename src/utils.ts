export const convertSecondsToTimestamp = function(seconds: number) {
  const tempMin = Math.floor(seconds / 60);

  return [
    Math.floor(tempMin / 60).toString().padStart(2, '0'),
    (tempMin % 60).toString().padStart(2, '0'),
    Math.floor(seconds % 60).toString().padStart(2, '0')
  ].join(':') + '.' + Math.floor(
    (seconds - Math.floor(seconds)) * 1000
  ).toString().padStart(3, '0');
}