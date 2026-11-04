import { API_VERSION, API_VERSIONS_HEADER } from './schemas';

/** What a server that doesn't advertise its versions speaks: version 1 was all there ever was before the header existed. */
const IMPLICIT_SERVER_VERSIONS: readonly number[] = [1];

export type ApiCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      /** `app_too_old`: the server has moved past this app, so the app needs updating. `server_too_old`: the app is newer than the server, so the server needs updating. */
      problem: 'app_too_old' | 'server_too_old';
      message: string;
    };

/** Reads the versions a server advertised in its response headers; none advertised means an older server that speaks only version 1. */
export function parseServerApiVersions(header: string | null | undefined): number[] {
  if (header === null || header === undefined || header.trim() === '') return [...IMPLICIT_SERVER_VERSIONS];
  const versions = header
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return versions.length > 0 ? versions : [...IMPLICIT_SERVER_VERSIONS];
}

/** Whether a client speaking `clientVersion` can talk to a server that speaks `serverVersions`, and if not, which side has to update. */
export function checkApiCompatibility(clientVersion: number, serverVersions: readonly number[]): ApiCompatibility {
  if (serverVersions.includes(clientVersion)) return { compatible: true };
  const newest = Math.max(...serverVersions);
  if (clientVersion < newest) {
    return { compatible: false, problem: 'app_too_old', message: `This server needs a newer version of the app (the app speaks API version ${clientVersion}; the server speaks ${describeVersions(serverVersions)}). Update the app to keep using it.` };
  }
  return { compatible: false, problem: 'server_too_old', message: `This server is older than the app (the app speaks API version ${clientVersion}; the server speaks ${describeVersions(serverVersions)}). Update the server, or use an older version of the app.` };
}

/** Checks the versions a response advertises against this build's own. */
export function checkResponseCompatibility(response: { headers: { get(name: string): string | null } }): ApiCompatibility {
  return checkApiCompatibility(API_VERSION, parseServerApiVersions(response.headers.get(API_VERSIONS_HEADER)));
}

function describeVersions(versions: readonly number[]): string {
  return versions.length === 1 ? String(versions[0]) : [...versions].sort((a, b) => a - b).join(', ');
}
