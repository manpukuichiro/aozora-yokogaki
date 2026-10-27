// 保存先は配信ディレクトリ単位。同一オリジンの別アプリからの隔離ではない。
const ReaderData = (() => {
  const scope = encodeURIComponent(new URL('.', location.href).pathname);
  const prefix = 'aozora-reader:v2:' + scope + ':';
  const databaseName = 'aozora-reader:v2:' + scope;
  return { prefix, databaseName };
})();
globalThis.ReaderData = ReaderData;
