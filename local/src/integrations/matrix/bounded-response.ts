export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maximumBytes
  ) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  return joinChunks(chunks, total);
}

export async function readBoundedJson<T>(
  response: Response,
  maximumBytes: number,
  label: string
): Promise<T> {
  const raw = await readBoundedResponseBytes(response, maximumBytes, label);
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export async function readResponsePrefix(
  response: Response,
  maximumBytes: number
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maximumBytes) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maximumBytes - total;
    const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
    chunks.push(chunk);
    total += chunk.byteLength;
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  if (total >= maximumBytes) {
    await reader.cancel();
  }
  return new TextDecoder().decode(joinChunks(chunks, total));
}

function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
