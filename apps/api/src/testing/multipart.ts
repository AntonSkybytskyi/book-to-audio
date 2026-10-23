/** Builds a `multipart/form-data` body for `app.inject`. */
export function multipartBody(files: { name?: string; filename: string; data: Buffer | string }[]) {
  const boundary = "----test-boundary-7MA4YWxkTrZu0gW";
  const parts = files.flatMap(({ name = "file", filename, data }) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.from(data),
    Buffer.from("\r\n"),
  ]);
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
