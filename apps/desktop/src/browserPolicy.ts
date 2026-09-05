export type BrowserMediaState = {
  focused: boolean;
  mediaOrigin: string;
  media: { microphone: boolean; camera: boolean };
};
export function allowsBrowserMedia(
  state: BrowserMediaState,
  sameContents: boolean,
  currentUrl: string,
  requestingOrigin: string,
  mediaType: string,
): boolean {
  try {
    const current = new URL(currentUrl),
      requesting = new URL(requestingOrigin);
    return (
      sameContents &&
      state.focused &&
      current.protocol === 'https:' &&
      requesting.protocol === 'https:' &&
      current.origin === state.mediaOrigin &&
      requesting.origin === state.mediaOrigin &&
      (mediaType === 'audio'
        ? state.media.microphone
        : mediaType === 'video'
          ? state.media.camera
          : false)
    );
  } catch {
    return false;
  }
}
