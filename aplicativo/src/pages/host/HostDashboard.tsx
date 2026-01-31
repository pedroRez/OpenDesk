import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { setPrimaryPcId } from '../../lib/hostState';

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

export default function HostDashboard() {
  const { user, updateUser } = useAuth();
  const [pcs, setPcs] = useState<PC[]>([]);
  const [message, setMessage] = useState('');
  const [isLoadingPcs, setIsLoadingPcs] = useState(false);
  const [isCreatingHost, setIsCreatingHost] = useState(false);
  const [editingPcId, setEditingPcId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    connectionHost: '',
    connectionPort: 47990,
    connectionNotes: '',
  });
  const [form, setForm] = useState<PCInput>({
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

  const hostProfileId = user?.hostProfileId ?? null;
  const isHost = useMemo(() => Boolean(hostProfileId), [hostProfileId]);

  useEffect(() => {
    if (!hostProfileId) return;
    setIsLoadingPcs(true);
    fetchJson<PC[]>('/pcs')
      .then((data) => {
        const hostPcs = data.filter((pc) => pc.hostId === hostProfileId);
        setPcs(hostPcs);
        if (hostPcs.length > 0) {
          setPrimaryPcId(hostPcs[0].id);
        }
      })
      .catch(() => setPcs([]))
      .finally(() => setIsLoadingPcs(false));
  }, [hostProfileId]);

  const handleCreateHostProfile = async () => {
    if (!user) return;
    setIsCreatingHost(true);
    setMessage('');
    try {
      const data = await fetchJson<{ hostProfileId?: string; hostProfile?: { id: string } }>('/hosts', {
        method: 'POST',
        body: JSON.stringify({ displayName: user.name ?? 'Novo Host' }),
      });
      const hostId = data.hostProfileId ?? data.hostProfile?.id ?? null;
      updateUser({ role: 'HOST', hostProfileId: hostId });
      setMessage('Perfil de host criado com sucesso!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao criar perfil.');
    } finally {
      setIsCreatingHost(false);
    }
  };

  const handleCreatePC = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');

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
      const created = await fetchJson<PC>('/pcs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => [created, ...prev]);
      setPrimaryPcId(created.id);
      setMessage('PC cadastrado com sucesso!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao cadastrar PC');
    }
  };

  const handleToggleStatus = async (pc: PC) => {
    if (pc.status === 'BUSY') {
      setMessage('PC ocupado. Nao e possivel ficar offline agora.');
      return;
    }
    const nextStatus = pc.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
    try {
      const data = await fetchJson<{ pc: PC }>(`/pcs/${pc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? data.pc : item)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao atualizar status.');
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
    setMessage('');
    try {
      const payload = {
        connectionHost: editForm.connectionHost.trim() || undefined,
        connectionPort: Number(editForm.connectionPort) || undefined,
        connectionNotes: editForm.connectionNotes.trim() || undefined,
      };
      const updated = await fetchJson<PC>(`/pcs/${pc.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setPcs((prev) => prev.map((item) => (item.id === pc.id ? updated : item)));
      setEditingPcId(null);
      setMessage('Dados de conexao atualizados.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao atualizar conexao.');
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
        <>
          <form onSubmit={handleCreatePC} className={styles.form}>
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
                <input value={form.cpu} onChange={(event) => setForm({ ...form, cpu: event.target.value })} required />
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
            <button type="submit">Cadastrar PC</button>
          </form>

          <section className={styles.list}>
            <h3>Seus PCs</h3>
            {isLoadingPcs && <p>Carregando PCs...</p>}
            {!isLoadingPcs && pcs.length === 0 && <p>Nenhum PC cadastrado.</p>}
            {pcs.map((pc) => (
              <div key={pc.id} className={styles.pcCard}>
                <div className={styles.pcInfo}>
                  <strong>{pc.name}</strong>
                  <span className={styles.pcStatus}>{pc.status}</span>
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
            ))}
          </section>
        </>
      )}

      {message && <p className={styles.message}>{message}</p>}
    </section>
  );
}
