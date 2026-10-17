declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Uint8Array;
    static sync: { read: (buffer: Buffer) => PNG };
  }
}

declare module "jpeg-js" {
  interface Decoded {
    width: number;
    height: number;
    data: Uint8Array;
  }
  export function decode(buffer: Buffer, opts?: { useTArray?: boolean }): Decoded;
  const jpeg: { decode: typeof decode };
  export default jpeg;
}
