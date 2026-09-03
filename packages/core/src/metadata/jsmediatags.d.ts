/** jsmediatags ships no types of its own and @types/jsmediatags's are effectively `any` - this covers only the surface readTags.ts actually uses. */
declare module 'jsmediatags/dist/jsmediatags.min.js' {
  export interface TagType {
    tags: {
      title?: string;
      artist?: string;
      album?: string;
      [key: string]: unknown;
    };
  }

  export interface TagError {
    type: string;
    info: unknown;
  }

  export interface ReadCallbacks {
    onSuccess: (tag: TagType) => void;
    onError: (error: TagError) => void;
  }

  export class Reader {
    constructor(file: unknown);
    setTagsToRead(tagsToRead: string[]): Reader;
    read(callbacks: ReadCallbacks): void;
  }
}
