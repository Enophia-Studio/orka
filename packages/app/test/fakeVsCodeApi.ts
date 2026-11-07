// The webview API as a page gets it, for tests of the page's own modules. Imported before them:
// they call acquireVsCodeApi() as they load.

/** Every message the page posted to the app. */
export const pagePosted: unknown[] = [];

/** Every state the page saved. */
export const pageStates: unknown[] = [];

(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => void pagePosted.push(message),
  getState: () => undefined,
  setState: (state: unknown) => void pageStates.push(state),
});
