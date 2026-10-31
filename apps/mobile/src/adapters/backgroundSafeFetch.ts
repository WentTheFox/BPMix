import { utf8Decode } from '@bpmix/core';

/**
 * A `fetch` that keeps working while the Android app is backgrounded.
 *
 * React Native's own `fetch` is the whatwg-fetch polyfill, which settles every request from inside a
 * `setTimeout(..., 0)` (see its `xhr.onload`), and React Native pauses JS timers while the activity is
 * in the background. The request itself goes out and the server answers, but the promise stays pending
 * until the app is foregrounded again, which stalled the playback-state push, the mutation queue
 * behind it, and so scrobbling. This settles straight from the XHR callbacks instead, with no timer
 * anywhere in the path.
 *
 * Only what the app's API client uses is supported: string bodies, and an `AbortSignal` to cancel.
 * Anything that isn't an http(s) address (local file:// reads) goes to the original `fetch`.
 */
export function createBackgroundSafeFetch(original: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return /^https?:/i.test(url) ? xhrFetch(input, init) : original(input, init);
  };
}

const xhrFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const request = new Request(input, init);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const finish = () => signal?.removeEventListener('abort', onAbort);

    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      finish();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const buffer = xhr.status === 204 || xhr.status === 304 ? null : (xhr.response as ArrayBuffer);
      const response = new Response(buffer, { status: xhr.status, statusText: xhr.statusText, headers });
      if (buffer) {
        // The polyfilled Response reads an ArrayBuffer body one byte per character (Latin-1), which garbles every non-ASCII title.
        response.text = () => Promise.resolve(utf8Decode(new Uint8Array(buffer)));
        response.json = () => response.text().then((text) => JSON.parse(text) as unknown);
      }
      resolve(response);
    };
    xhr.onerror = () => {
      finish();
      reject(new TypeError('Network request failed'));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => {
      finish();
      reject(abortError());
    };

    xhr.open(request.method, request.url, true);
    request.headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    signal?.addEventListener('abort', onAbort);
    // `Request` keeps no readable body in React Native, so send what the caller gave.
    xhr.send(typeof init?.body === 'string' ? init.body : null);
  });

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
