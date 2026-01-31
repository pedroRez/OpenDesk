export type StreamingProvider = {
  connect: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  disconnect: (sessionId: string) => Promise<void>;
  isInstalled: () => Promise<boolean>;
};

export const ExternalPlaceholderProvider: StreamingProvider = {
  async connect() {
    return {
      ok: false,
      message: 'Use um cliente externo (ex: Moonlight) para conectar.',
    };
  },
  async disconnect() {
    return;
  },
  async isInstalled() {
    return false;
  },
};

// TODO: implementar providers reais
// - baixar/instalar Moonlight/Sunshine
// - iniciar Sunshine no host
// - abrir Moonlight no cliente com 1 clique
export function getStreamingProvider(): StreamingProvider {
  return ExternalPlaceholderProvider;
}
