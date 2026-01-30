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
};

export default function HostDashboardPage() {
  const { user, updateUser } = useAuth();
  const [software, setSoftware] = useState<Software[]>([]);
  const [selectedSoftware, setSelectedSoftware] = useState<string>('');
  const [pcId, setPcId] = useState('');
  const [pcs, setPcs] = useState<PC[]>([]);
  const [message, setMessage] = useState('');
  const [isLoadingPcs, setIsLoadingPcs] = useState(false);
  const [isCreatingHost, setIsCreatingHost] = useState(false);
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
  });

  const hostProfileId = user?.hostProfileId ?? null;
  const isHost = useMemo(() => Boolean(hostProfileId), [hostProfileId]);

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
          body: JSON.stringify({ displayName: user.name ?? 'Novo Host' }),
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
      const created = await fetchJson<PC>('/pcs', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          ramGb: Number(form.ramGb),
          vramGb: Number(form.vramGb),
          internetUploadMbps: Number(form.internetUploadMbps),
          pricePerHour: Number(form.pricePerHour),
        }),
      });
      setPcId(created.id);
      setPcs((prev) => [created, ...prev]);
      setMessage('PC cadastrado com sucesso!');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Erro ao cadastrar PC');
    }
  };

  const handleLinkSoftware = async () => {
    if (!pcId || !selectedSoftware) return;
    try {
      await fetchJson(`/pcs/${pcId}/software`, {
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

            <div className={styles.softwarePanel}>
              <h3>Vincular software</h3>
              <label>
                PC recem criado (ID)
                <input value={pcId} onChange={(event) => setPcId(event.target.value)} />
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
              <button type="button" onClick={handleLinkSoftware}>
                Vincular
              </button>
            </div>

            <section className={styles.pcList}>
              <h3>Seus PCs</h3>
              {isLoadingPcs && <p>Carregando PCs...</p>}
              {!isLoadingPcs && pcs.length === 0 && <p>Nenhum PC cadastrado.</p>}
              {pcs.map((pc) => (
                <div key={pc.id} className={styles.pcCard}>
                  <div>
                    <strong>{pc.name}</strong>
                    <div className={styles.pcStatus}>{pc.status}</div>
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
                  </div>
                </div>
              ))}
            </section>
          </>
        )}

        {message && <p>{message}</p>}
      </div>
    </ProtectedRoute>
  );
}
