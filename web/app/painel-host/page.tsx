'use client';

import { useEffect, useState } from 'react';

import { apiBaseUrl } from '../../lib/api';

import styles from './page.module.css';

type Software = { id: string; name: string };

type PCInput = {
  hostId: string;
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

export default function HostPanelPage() {
  const [software, setSoftware] = useState<Software[]>([]);
  const [selectedSoftware, setSelectedSoftware] = useState<string>('');
  const [pcId, setPcId] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<PCInput>({
    hostId: '',
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

  useEffect(() => {
    fetch(`${apiBaseUrl}/software`)
      .then((res) => res.json())
      .then(setSoftware)
      .catch(() => setSoftware([]));
  }, []);

  const handleCreatePC = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage('');

    const response = await fetch(`${apiBaseUrl}/pcs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        ramGb: Number(form.ramGb),
        vramGb: Number(form.vramGb),
        internetUploadMbps: Number(form.internetUploadMbps),
        pricePerHour: Number(form.pricePerHour),
      }),
    });
    const data = await response.json();
    if (response.ok) {
      setPcId(data.id);
      setMessage('PC cadastrado com sucesso!');
    } else {
      setMessage(data.error ?? 'Erro ao cadastrar PC');
    }
  };

  const handleLinkSoftware = async () => {
    if (!pcId || !selectedSoftware) return;
    const response = await fetch(`${apiBaseUrl}/pcs/${pcId}/software`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ softwareId: selectedSoftware }),
    });
    const data = await response.json();
    setMessage(response.ok ? 'Software vinculado!' : data.error ?? 'Erro');
  };

  return (
    <div className={styles.container}>
      <h1>Painel do Host</h1>
      <form onSubmit={handleCreatePC} className={styles.form}>
        <label>
          Host ID
          <input
            value={form.hostId}
            onChange={(event) => setForm({ ...form, hostId: event.target.value })}
            required
          />
        </label>
        <label>
          Nome do PC
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </label>
        <label>
          Nível
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
          Preço por hora
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
          PC recém criado (ID)
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

      {message && <p>{message}</p>}
    </div>
  );
}
