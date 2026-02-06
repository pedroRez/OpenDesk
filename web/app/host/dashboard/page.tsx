'use client';

import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import ProtectedRoute from '../../../components/ProtectedRoute';

import styles from './page.module.css';

type Software = { id: string; name: string };

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

export default function HostDashboardPage() {
  const { user, updateUser } = useAuth();
  const [software, setSoftware] = useState<Software[]>([]);
  const [selectedSoftware, setSelectedSoftware] = useState<string>('');
  const [selectedPcId, setSelectedPcId] = useState('');
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
  const [activeTab, setActiveTab] = useState<'create' | 'software' | 'list'>('create');
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
  const canLinkSoftware = Boolean(selectedPcId && selectedSoftware);

  useEffect(() => {
    fetchJson<Software[]>('/software')
      .then(setSoftware)
      .catch(() => setSoftware([]));
  }, []);

  useEffect(() => {
    if (!hostProfileId) return;
    const ping = () =>
      fetchJson(`/hosts/${hostProfileId}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({}),
      }).catch(() => undefined);
    ping();
    const intervalId = setInterval(ping, 25000);
    return () => clearInterval(intervalId);
  }, [hostProfileId]);

  useEffect(() => {
    if (!hostProfileId) return;
    setIsLoadingPcs(true);
    fetchJson<PC[]>('/pcs')
      .then((data) => {
        setPcs(data.filter((pc) => pc.hostId === hostProfileId));
      })
      .catch(() => setPcs([]))
      .finally(() => setIsLoadingPcs(false));
  }, [hostProfileId]);

  const handleCreateHostProfile = async () => {
    if (!user) return;
    setIsCreatingHost(true);
    setMessage('');
    try {
      const data = await fetchJson<{ hostProfileId?: string; hostProfile?: { id: string } }>(
        '/hosts',
        {
          method: 'POST',
          body: JSON.stringify({ displayName: user.displayName ?? user.username }),
        },
      );
      const hostId = data.hostProfileId ?? data.hostProfile?.id ?? null;
      updateUser({ role: 'HOST', hostProfileId: hostId });
      setMessage('Perfil de host criado com sucesso!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao criar perfil.');
    } finally {
      setIsCreatingHost(false);
    }
  };

  const handleCreatePC = async (event: React.FormEvent) => {
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
      setSelectedPcId(created.id);
      setPcs((prev) => [created, ...prev]);
      setMessage('PC cadastrado com sucesso!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao cadastrar PC');
    }
  };

  const handleLinkSoftware = async () => {
    if (!selectedPcId || !selectedSoftware) return;
    try {
      await fetchJson(`/pcs/${selectedPcId}/software`, {
        method: 'POST',
        body: JSON.stringify({ softwareId: selectedSoftware }),
      });
      setMessage('Software vinculado!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro');
    }
  };

  const handleToggleStatus = async (pc: PC) => {
    if (pc.status === 'BUSY') {
      setMessage('PC ocupado. Não é possível ficar offline agora.');
      return;
    }
    const nextStatus = pc.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
    try {
      const data = await fetchJson<{ pc: PC }>(`/pcs/${pc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setPcs((prev) =>
        prev.map((item) => (item.id === pc.id ? data.pc : item)),
      );
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
    <ProtectedRoute redirectTo="/login?next=/host/dashboard">
      <div className={styles.container}>
        <h1>Painel do Host</h1>

        {!isHost && (
          <div className={styles.cta}>
            <strong>Voce ainda nao e host.</strong>
            <span>Crie seu perfil para cadastrar PCs e ficar online.</span>
            <button type="button" onClick={handleCreateHostProfile} disabled={isCreatingHost}>
              {isCreatingHost ? 'Criando...' : 'Quero ser host'}
            </button>
          </div>
        )}

        {isHost && (
          <>
            <div className={styles.tabs}>
              <button
                type="button"
                onClick={() => setActiveTab('create')}
                className={`${styles.tab} ${activeTab === 'create' ? styles.tabActive : ''}`}
              >
                Cadastrar PC
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('software')}
                className={`${styles.tab} ${activeTab === 'software' ? styles.tabActive : ''}`}
              >
                Vincular software
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('list')}
                className={`${styles.tab} ${activeTab === 'list' ? styles.tabActive : ''}`}
              >
                Meus PCs
              </button>
            </div>

            {activeTab === 'create' && (
              <form onSubmit={handleCreatePC} className={styles.form}>
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
                  <select
                    value={form.level}
                    onChange={(event) => setForm({ ...form, level: event.target.value })}
                  >
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
                  <input
                    value={form.gpu}
                    onChange={(event) => setForm({ ...form, gpu: event.target.value })}
                  />
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
                    onChange={(event) =>
                      setForm({ ...form, internetUploadMbps: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Connection Host (IP/DNS)
                  <input
                    value={form.connectionHost}
                    onChange={(event) =>
                      setForm({ ...form, connectionHost: event.target.value })
                    }
                    placeholder="192.168.0.10"
                  />
                </label>
                <label>
                  Connection Port
                  <input
                    type="number"
                    value={form.connectionPort}
                    onChange={(event) =>
                      setForm({ ...form, connectionPort: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Connection Notes
                  <input
                    value={form.connectionNotes}
                    onChange={(event) =>
                      setForm({ ...form, connectionNotes: event.target.value })
                    }
                    placeholder="Use Moonlight, perfil 1080p"
                  />
                </label>
                <label>
                  Preco por hora
                  <input
                    type="number"
                    value={form.pricePerHour}
                    onChange={(event) =>
                      setForm({ ...form, pricePerHour: Number(event.target.value) })
                    }
                  />
                </label>
                <button type="submit">Cadastrar PC</button>
              </form>
            )}

            {activeTab === 'software' && (
              <div className={styles.softwarePanel}>
                <h3>Vincular software</h3>
                <label>
                  Selecione o PC
                  <select
                    value={selectedPcId}
                    onChange={(event) => setSelectedPcId(event.target.value)}
                  >
                    <option value="">Escolha um PC</option>
                    {pcs.map((pc) => (
                      <option key={pc.id} value={pc.id}>
                        {pc.name} ({pc.id.slice(0, 6)})
                      </option>
                    ))}
                  </select>
                  {pcs.length === 0 && <span>Cadastre um PC antes de vincular.</span>}
                </label>
                <select
                  value={selectedSoftware}
                  onChange={(event) => setSelectedSoftware(event.target.value)}
                >
                  <option value="">Selecione</option>
                  {software.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={handleLinkSoftware} disabled={!canLinkSoftware}>
                  Vincular
                </button>
              </div>
            )}

            {activeTab === 'list' && (
              <section className={styles.pcList}>
                <h3>Seus PCs</h3>
                {isLoadingPcs && <p>Carregando PCs...</p>}
                {!isLoadingPcs && pcs.length === 0 && <p>Nenhum PC cadastrado.</p>}
                {pcs.map((pc) => (
                  <div key={pc.id}>
                    <div className={styles.pcCard}>
                      <div className={styles.pcInfo}>
                        <strong>{pc.name}</strong>
                        <div className={styles.pcStatus}>{pc.status}</div>
                        <div>
                          Conexao: {pc.connectionHost ?? 'Nao informado'}:
                          {pc.connectionPort ?? 47990}
                        </div>
                        {pc.connectionNotes && <div>Notas: {pc.connectionNotes}</div>}
                      </div>
                      <div className={styles.pcActions}>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(pc)}
                          className={`${styles.toggle} ${pc.status === 'BUSY' ? styles.toggleDisabled : ''}`}
                          disabled={pc.status === 'BUSY'}
                        >
                          {pc.status === 'ONLINE' ? 'Ficar Offline' : 'Ficar Online'}
                        </button>
                        <button type="button" onClick={() => startEditing(pc)} className={styles.toggle}>
                          Editar conexao
                        </button>
                      </div>
                    </div>

                    {editingPcId === pc.id && (
                      <div className={styles.editPanel}>
                        <label>
                          Connection Host (IP/DNS)
                          <input
                            value={editForm.connectionHost}
                            onChange={(event) =>
                              setEditForm({ ...editForm, connectionHost: event.target.value })
                            }
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
                            onChange={(event) =>
                              setEditForm({ ...editForm, connectionNotes: event.target.value })
                            }
                            placeholder="Use Moonlight, perfil 1080p"
                          />
                        </label>
                        <div className={styles.editActions}>
                          <button type="button" onClick={() => handleSaveConnection(pc)}>
                            Salvar conexao
                          </button>
                          <button type="button" onClick={() => setEditingPcId(null)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {message && <p>{message}</p>}
      </div>
    </ProtectedRoute>
  );
}
