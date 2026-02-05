import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '../../components/Toast';
import { request } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { getLocalPcId, getPrimaryPcId, setLocalPcId, setPrimaryPcId } from '../../lib/hostState';
import { DEFAULT_CONNECT_HINT, resolveConnectAddress } from '../../lib/networkAddress';
import { ensureSunshineRunning } from '../../lib/sunshineController';

import styles from './HostDashboard.module.css';

type PC = {
  id: string;
  hostId: string;
  name: string;
  level: string;
  status: 'ONLINE' | 'OFFLINE' | 'BUSY';
  pricePerHour: number;
  connectionHost?: string | null;
  connectionPort?: number | null;
  connectionNotes?: string | null;
  cpu?: string;
  ramGb?: number;
  gpu?: string;
  vramGb?: number;
  storageType?: string;
  internetUploadMbps?: number;
};

type PCInput = {
  name: string;
  level: string;
  cpu: string;
  ramGb: number;
  gpu: string;
  vramGb: number;
  storageType: string;
  internetUploadMbps: number;
  pricePerHour: number;
  connectionHost: string;
  connectionPort: number;
  connectionNotes: string;
};

const createDefaultForm = (): PCInput => ({
  name: '',
  level: 'B',
  cpu: '',
  ramGb: 16,
  gpu: '',
  vramGb: 8,
  storageType: 'SSD',
  internetUploadMbps: 200,
  pricePerHour: 10,
  connectionHost: '',
  connectionPort: 47990,
  connectionNotes: '',
});

export default function HostDashboard() {
  const { user, updateUser } = useAuth();
  const toast = useToast();
  const [pcs, setPcs] = useState<PC[]>([]);
  const [isLoadingPcs, setIsLoadingPcs] = useState(false);
  const [isCreatingHost, setIsCreatingHost] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingPcId, setEditingPcId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    connectionHost: '',
    connectionPort: 47990,
    connectionNotes: '',
  });
  const [form, setForm] = useState<PCInput>(createDefaultForm);
  const [isPublishingNetwork, setIsPublishingNetwork] = useState(false);

  const hostProfileId = user?.hostProfileId ?? null;
  const isHost = useMemo(() => Boolean(hostProfileId), [hostProfileId]);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHeartbeatLogRef = useRef<number>(0);
  const heartbeatPcId = useMemo(() => {
    const localId = getLocalPcId();
    if (localId) {
      const localPc = pcs.find((pc) => pc.id === localId);
      if (localPc?.status === 'ONLINE') {
        return localPc.id;
      }
    }
    const primaryId = getPrimaryPcId();
    if (primaryId) {
      const primaryPc = pcs.find((pc) => pc.id === primaryId);
      if (primaryPc?.status === 'ONLINE') {
        return primaryPc.id;
      }
    }
    const anyOnline = pcs.find((pc) => pc.status === 'ONLINE');
    return anyOnline?.id ?? null;
  }, [pcs]);

  useEffect(() => {
    if (!hostProfileId) return;
    setIsLoadingPcs(true);
    request<PC[]>('/host/pcs')
      .then((data) => {
        setPcs(data);
        if (data.length > 0) {
          setPrimaryPcId(data[0].id);
        }
      })
      .catch((error) => {
        setPcs([]);
        const message = error instanceof Error ? error.message : 'Erro ao carregar PCs';
        toast.show(message, 'error');
      })
      .finally(() => setIsLoadingPcs(false));
  }, [hostProfileId, toast]);

  useEffect(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (!hostProfileId || !user?.id || !heartbeatPcId) {
      return;
    }

    const hostId = hostProfileId;
    const pcId = heartbeatPcId;
    const intervalMs = 10000;
    console.log('[HB][DESKTOP] start', { hostId, pcId, intervalMs });

    const sendHeartbeat = async () => {
      const timestamp = new Date().toISOString();
      try {
        await request(`/hosts/${hostId}/heartbeat`, {
          method: 'POST',
          body: JSON.stringify({ pcId, timestamp }),
        });
        const logLevel = (import.meta.env.VITE_LOG_HEARTBEAT ?? 'sampled').toLowerCase();
        const isDebug = logLevel === 'debug' || logLevel === 'full' || logLevel === 'true';
        if (logLevel !== 'off' && logLevel !== 'false') {
          if (isDebug) {
            console.log('[HB][DESKTOP] alive', { hostId, pcId, timestamp });
          } else {
            const sampleSeconds = Number(import.meta.env.VITE_HEARTBEAT_LOG_SAMPLE_SECONDS ?? 60);
            const nowMs = Date.now();
            if (nowMs - lastHeartbeatLogRef.current >= sampleSeconds * 1000) {
              lastHeartbeatLogRef.current = nowMs;
              console.log('[HB][DESKTOP] alive', { hostId, pcId, timestamp });
            }
          }
        }
      } catch (error) {
        console.error('[HB][DESKTOP] fail status', {
          hostId,
          pcId,
          timestamp,
          error: error instanceof Error ? error.message : error,
        });
      }
    };

    sendHeartbeat();
    heartbeatRef.current = setInterval(sendHeartbeat, intervalMs);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [hostProfileId, user?.id, heartbeatPcId]);

  const handleCreateHostProfile = async () => {
    if (!user) return;
    setIsCreatingHost(true);
    try {
      const data = await request<{ hostProfileId?: string; hostProfile?: { id: string } }>('/host/profile', {
        method: 'POST',
        body: JSON.stringify({ displayName: user.name ?? 'Novo Host' }),
      });
      const hostId = data.hostProfileId ?? data.hostProfile?.id ?? null;
      updateUser({ role: 'HOST', hostProfileId: hostId });
      toast.show('Perfil de host criado com sucesso!', 'success');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao criar perfil.', 'error');
    } finally {
      setIsCreatingHost(false);
    }
  };

  const handleCreatePC = async (event: FormEvent) => {
    event.preventDefault();

    try {
      const payload = {
        ...form,
        connectionHost: form.connectionHost.trim() || undefined,
        connectionNotes: form.connectionNotes.trim() || undefined,
        connectionPort: Number(form.connectionPort) || undefined,
        ramGb: Number(form.ramGb),
        vramGb: Number(form.vramGb),
        internetUploadMbps: Number(form.internetUploadMbps),
        pricePerHour: Number(form.pricePerHour),
      };
      const created = await request<PC>('/pcs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => [created, ...prev]);
      setPrimaryPcId(created.id);
      setLocalPcId(created.id);
      toast.show('PC cadastrado com sucesso!', 'success');
      setForm(createDefaultForm());
      setIsFormOpen(false);
      if (created.status === 'ONLINE') {
        await publishNetwork(created.id);
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao cadastrar PC', 'error');
    }
  };

  const handleToggleStatus = async (pc: PC) => {
    if (pc.status === 'BUSY') {
      toast.show('PC ocupado. Nao e possivel ficar offline agora.', 'info');
      return;
    }
    const nextStatus = pc.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
    setPcs((prev) => prev.map((item) => (item.id === pc.id ? { ...item, status: nextStatus } : item)));
    try {
      const data = await request<{ pc: PC }>(`/pcs/${pc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? data.pc : item)));
      toast.show(nextStatus === 'ONLINE' ? 'PC ficou online' : 'PC ficou offline', 'success');
      if (nextStatus === 'ONLINE') {
        await publishNetwork(pc.id);
      }
    } catch (error) {
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? pc : item)));
      toast.show(error instanceof Error ? error.message : 'Falha ao atualizar status', 'error');
    }
  };

  const publishNetwork = async (pcId: string) => {
    if (isPublishingNetwork) return;
    setIsPublishingNetwork(true);
    console.log('[NET][HOST] publishing connectAddress', { pcId });
    try {
      const running = await ensureSunshineRunning();
      if (!running) {
        console.error('[NET][HOST] sunshine not running; abort publish', { pcId });
        return;
      }
      const connectAddress = await resolveConnectAddress();
      await request(`/pcs/${pcId}/network`, {
        method: 'POST',
        body: JSON.stringify({
          networkProvider: 'DIRECT',
          connectAddress,
          connectHint: DEFAULT_CONNECT_HINT,
        }),
      });
      console.log('[NET][HOST] publish ok', { pcId, connectHint: DEFAULT_CONNECT_HINT });
    } catch (error) {
      console.error('[NET][HOST] publish fail', {
        pcId,
        error: error instanceof Error ? error.message : error,
      });
    } finally {
      setIsPublishingNetwork(false);
    }
  };

  const startEditing = (pc: PC) => {
    setEditingPcId(pc.id);
    setEditForm({
      connectionHost: pc.connectionHost ?? '',
      connectionPort: pc.connectionPort ?? 47990,
      connectionNotes: pc.connectionNotes ?? '',
    });
  };

  const handleSaveConnection = async (pc: PC) => {
    try {
      const payload = {
        connectionHost: editForm.connectionHost.trim() || undefined,
        connectionPort: Number(editForm.connectionPort) || undefined,
        connectionNotes: editForm.connectionNotes.trim() || undefined,
      };
      const updated = await request<PC>(`/pcs/${pc.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? updated : item)));
      setEditingPcId(null);
      toast.show('Dados de conexao atualizados.', 'success');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'Erro ao atualizar conexao.', 'error');
    }
  };

  return (
    <section className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Painel do Host</h1>
          <p>Gerencie seus PCs e fique online quando quiser.</p>
        </div>
      </div>

      {!isHost && (
        <div className={styles.cta}>
          <strong>Voce ainda nao e host.</strong>
          <span>Crie seu perfil para cadastrar PCs e ficar online.</span>
          <button type="button" onClick={handleCreateHostProfile} disabled={isCreatingHost}>
            {isCreatingHost ? 'Criando...' : 'Criar perfil host'}
          </button>
        </div>
      )}

      {isHost && (
        <section className={styles.list}>
          <div className={styles.listHeader}>
            <div>
              <h3>Seus PCs</h3>
              <p className={styles.listHint}>Controle disponibilidade e conexao por PC.</p>
            </div>
            <button
              type="button"
              onClick={() => setIsFormOpen((prev) => !prev)}
              className={styles.toggleButton}
              aria-expanded={isFormOpen}
              aria-controls="pc-form"
            >
              <span>{isFormOpen ? 'Fechar cadastro' : 'Cadastrar PC'}</span>
              <span className={styles.toggleIcon}>{isFormOpen ? 'v' : '>'}</span>
            </button>
          </div>

          {isFormOpen && (
            <form onSubmit={handleCreatePC} className={`${styles.form} ${styles.formPanel}`} id="pc-form">
              <h3>Cadastrar PC</h3>
              <div className={styles.grid}>
                <label>
                  Nome do PC
                  <input
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    required
                  />
                </label>
                <label>
                  Nivel
                  <select value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </select>
                </label>
                <label>
                  CPU
                  <input
                    value={form.cpu}
                    onChange={(event) => setForm({ ...form, cpu: event.target.value })}
                    required
                  />
                </label>
                <label>
                  RAM (GB)
                  <input
                    type="number"
                    value={form.ramGb}
                    onChange={(event) => setForm({ ...form, ramGb: Number(event.target.value) })}
                  />
                </label>
                <label>
                  GPU
                  <input value={form.gpu} onChange={(event) => setForm({ ...form, gpu: event.target.value })} />
                </label>
                <label>
                  VRAM (GB)
                  <input
                    type="number"
                    value={form.vramGb}
                    onChange={(event) => setForm({ ...form, vramGb: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Storage
                  <input
                    value={form.storageType}
                    onChange={(event) => setForm({ ...form, storageType: event.target.value })}
                  />
                </label>
                <label>
                  Upload (Mbps)
                  <input
                    type="number"
                    value={form.internetUploadMbps}
                    onChange={(event) => setForm({ ...form, internetUploadMbps: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Preco por hora
                  <input
                    type="number"
                    value={form.pricePerHour}
                    onChange={(event) => setForm({ ...form, pricePerHour: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Connection Host (IP/DNS)
                  <input
                    value={form.connectionHost}
                    onChange={(event) => setForm({ ...form, connectionHost: event.target.value })}
                    placeholder="192.168.0.10"
                  />
                </label>
                <label>
                  Connection Port
                  <input
                    type="number"
                    value={form.connectionPort}
                    onChange={(event) => setForm({ ...form, connectionPort: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Connection Notes
                  <input
                    value={form.connectionNotes}
                    onChange={(event) => setForm({ ...form, connectionNotes: event.target.value })}
                    placeholder="Use Moonlight, perfil 1080p"
                  />
                </label>
              </div>
              <div className={styles.formActions}>
                <button type="submit">Cadastrar PC</button>
                <button type="button" onClick={() => setIsFormOpen(false)} className={styles.ghost}>
                  Cancelar
                </button>
              </div>
            </form>
          )}

          {isLoadingPcs && <p>Carregando PCs...</p>}
          {!isLoadingPcs && pcs.length === 0 && <p>Nenhum PC cadastrado.</p>}
          {pcs.map((pc) => {
            const statusClass =
              pc.status === 'ONLINE'
                ? styles.statusOnline
                : pc.status === 'OFFLINE'
                  ? styles.statusOffline
                  : styles.statusBusy;

            return (
              <div key={pc.id} className={styles.pcCard}>
                <div className={styles.pcInfo}>
                  <div className={styles.pcHeader}>
                    <strong>{pc.name}</strong>
                    <span className={`${styles.statusBadge} ${statusClass}`}>{pc.status}</span>
                  </div>
                  <span>
                    Conexao: {pc.connectionHost ?? 'Nao informado'}:{pc.connectionPort ?? 47990}
                  </span>
                  {pc.connectionNotes && <span>Notas: {pc.connectionNotes}</span>}
                </div>
                <div className={styles.pcActions}>
                  <button
                    type="button"
                    onClick={() => handleToggleStatus(pc)}
                    className={pc.status === 'BUSY' ? styles.disabled : ''}
                    disabled={pc.status === 'BUSY'}
                  >
                    {pc.status === 'ONLINE' ? 'Ficar Offline' : 'Ficar Online'}
                  </button>
                  <button type="button" onClick={() => startEditing(pc)}>
                    Editar conexao
                  </button>
                </div>

                {editingPcId === pc.id && (
                  <div className={styles.editPanel}>
                    <label>
                      Connection Host (IP/DNS)
                      <input
                        value={editForm.connectionHost}
                        onChange={(event) => setEditForm({ ...editForm, connectionHost: event.target.value })}
                        placeholder="192.168.0.10"
                      />
                    </label>
                    <label>
                      Connection Port
                      <input
                        type="number"
                        value={editForm.connectionPort}
                        onChange={(event) =>
                          setEditForm({
                            ...editForm,
                            connectionPort: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Connection Notes
                      <input
                        value={editForm.connectionNotes}
                        onChange={(event) => setEditForm({ ...editForm, connectionNotes: event.target.value })}
                        placeholder="Use Moonlight, perfil 1080p"
                      />
                    </label>
                    <div className={styles.editActions}>
                      <button type="button" onClick={() => handleSaveConnection(pc)}>
                        Salvar conexao
                      </button>
                      <button type="button" onClick={() => setEditingPcId(null)} className={styles.ghost}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </section>
  );
}
