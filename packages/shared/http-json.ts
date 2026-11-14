export async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const stream = response.body?.getReader();
  if (!stream) throw new Error("Response body is missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new Error("Response exceeds its expected size");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
}
