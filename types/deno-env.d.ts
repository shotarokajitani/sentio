/**
 * `Deno.env.get` だけの最小宣言。
 *
 * **Edge Function の実物を統合試験から呼ぶために置いている。**
 * `_shared/dispatch-runtime.ts` は接続先を `Deno.env.get` で読むので、
 * Node 側の `tsc` からはこの名前が見えず `TS2304` になる。
 *
 * **`@types/deno` は入れない。** 全 API の型を持ち込むと、Node では動かない
 * `Deno.readFile` などを書いても型検査が通ってしまう。
 * ここにあるのは実際に使っている1つだけである。
 */
declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };
}
