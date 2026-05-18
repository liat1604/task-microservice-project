import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// All traffic goes through the nginx proxy → gateway
const API_BASE = '/api';

// ========================= THEME / DESIGN SYSTEM =========================
// Inspired by the micro-l Tasken design: Cormorant Garamond display font,
// Inter body, warm parchment/emerald palette, clean card-based layout.
const injectStyles = () => {
  if (document.getElementById('app-styles')) return;
  const style = document.createElement('style');
  style.id = 'app-styles';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: oklch(0.97 0.015 95);
      --card: oklch(0.99 0.01 95);
      --primary: oklch(0.32 0.08 160);
      --primary-fg: oklch(0.97 0.02 95);
      --accent: oklch(0.75 0.13 85);
      --accent-fg: oklch(0.2 0.04 160);
      --muted: oklch(0.93 0.02 95);
      --muted-fg: oklch(0.45 0.03 160);
      --border: oklch(0.88 0.02 95);
      --destructive: oklch(0.55 0.2 25);
      --destructive-fg: #fff;
      --font-display: 'Cormorant Garamond', Georgia, serif;
      --font-sans: 'Inter', system-ui, sans-serif;
      --radius: 0.5rem;
      --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.05);
    }
    body { background: var(--bg); color: var(--primary); font-family: var(--font-sans); font-size: 15px; }
    h1,h2,h3,h4 { font-family: var(--font-display); letter-spacing: -0.01em; }
    input, textarea, select {
      font-family: var(--font-sans); font-size: 14px;
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 9px 12px; width: 100%; background: var(--card);
      color: var(--primary); outline: none; transition: border-color 0.15s;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px oklch(0.75 0.13 85 / 0.25); }
    button { font-family: var(--font-sans); font-size: 14px; font-weight: 500; cursor: pointer; border: none; border-radius: var(--radius); transition: opacity 0.15s, background 0.15s; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-primary { background: var(--primary); color: var(--primary-fg); padding: 9px 16px; }
    .btn-primary:hover:not(:disabled) { background: oklch(0.28 0.09 160); }
    .btn-accent { background: var(--accent); color: var(--accent-fg); padding: 9px 16px; }
    .btn-outline { background: transparent; color: var(--primary); border: 1px solid var(--border); padding: 8px 14px; }
    .btn-outline:hover:not(:disabled) { background: var(--muted); }
    .btn-ghost { background: transparent; color: var(--muted-fg); padding: 8px 12px; }
    .btn-ghost:hover { background: var(--muted); color: var(--primary); }
    .btn-danger { background: var(--destructive); color: var(--destructive-fg); padding: 8px 14px; }
    .btn-sm { padding: 6px 11px; font-size: 13px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) + 2px); box-shadow: var(--shadow); }
    .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; padding: 3px 8px; border-radius: 100px; border: 1px solid transparent; }
    .badge-todo { background: var(--muted); color: var(--muted-fg); border-color: var(--border); }
    .badge-in_progress { background: oklch(0.92 0.08 85); color: oklch(0.4 0.1 85); border-color: oklch(0.75 0.13 85 / 0.4); }
    .badge-done { background: oklch(0.9 0.06 160); color: oklch(0.28 0.09 160); border-color: oklch(0.4 0.09 160 / 0.3); }
    .badge-high { background: oklch(0.93 0.06 25); color: var(--destructive); border-color: oklch(0.55 0.2 25 / 0.3); }
    .badge-medium { background: oklch(0.94 0.06 85); color: oklch(0.4 0.1 85); border-color: oklch(0.75 0.13 85 / 0.4); }
    .badge-low { background: var(--muted); color: var(--muted-fg); border-color: var(--border); }
    .badge-admin { background: var(--primary); color: var(--primary-fg); }
    .tag-chip { background: var(--muted); color: var(--muted-fg); border: 1px solid var(--border); font-size: 11px; padding: 2px 7px; border-radius: 100px; font-weight: 500; }
    .divider { height: 1px; background: var(--border); }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
    .toast-item { padding: 12px 16px; border-radius: var(--radius); font-size: 14px; box-shadow: var(--shadow-md); animation: slideIn 0.2s ease; }
    .toast-success { background: oklch(0.22 0.08 160); color: #fff; }
    .toast-error { background: var(--destructive); color: #fff; }
    @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
    .modal { background: var(--card); border-radius: calc(var(--radius) + 4px); box-shadow: var(--shadow-md); width: 100%; max-width: 500px; padding: 28px; }
    .modal-title { font-family: var(--font-display); font-size: 1.6rem; color: var(--primary); margin-bottom: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-label { display: block; font-size: 13px; font-weight: 500; color: var(--muted-fg); margin-bottom: 6px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .task-row { display: flex; align-items: flex-start; gap: 14px; padding: 16px; transition: border-color 0.15s; }
    .task-row:hover { border-color: oklch(0.75 0.13 85 / 0.6) !important; }
    .cycle-btn { flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid var(--border) !important; background: transparent; display: flex; align-items: center; justify-content: center; color: var(--muted-fg); padding: 0 !important; transition: border-color 0.15s, color 0.15s; }
    .cycle-btn:hover { border-color: var(--accent) !important; color: var(--accent); }
    .delete-btn { opacity: 0; transition: opacity 0.15s; }
    .task-row:hover .delete-btn { opacity: 1; }
    .filter-btn { padding: 6px 14px; font-size: 13px; border-radius: 100px; font-weight: 500; }
    .filter-active { background: var(--primary); color: var(--primary-fg); }
    .filter-inactive { background: transparent; color: var(--muted-fg); border: 1px solid var(--border); }
    .filter-inactive:hover { background: var(--muted); }
    .empty-state { text-align: center; padding: 60px 20px; border: 1.5px dashed var(--border); border-radius: var(--radius); }
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .metric-card { padding: 20px; }
    .metric-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted-fg); margin-bottom: 8px; }
    .metric-value { font-family: var(--font-display); font-size: 2.2rem; color: var(--primary); }
    .metric-value.danger { color: var(--destructive); }
    .stats-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .stats-table th { text-align: left; padding: 10px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-fg); border-bottom: 1px solid var(--border); background: var(--muted); }
    .stats-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: monospace; }
    .stats-table tr:last-child td { border-bottom: none; }
    .tab-bar { display: flex; gap: 4px; margin-bottom: 24px; }
    .tab { padding: 8px 16px; font-size: 14px; font-weight: 500; border-radius: var(--radius); border: none; background: transparent; color: var(--muted-fg); cursor: pointer; }
    .tab.active { background: var(--muted); color: var(--primary); }
    @media (max-width: 640px) { .grid-2 { grid-template-columns: 1fr; } .metrics-grid { grid-template-columns: 1fr 1fr; } }
  `;
  document.head.appendChild(style);
};

// ========================= TOAST SYSTEM =========================
let toastSetState = null;
const toast = {
  success: (msg) => toastSetState && toastSetState(prev => [...prev, { id: Date.now(), type: 'success', msg }]),
  error: (msg) => toastSetState && toastSetState(prev => [...prev, { id: Date.now(), type: 'error', msg }])
};

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  toastSetState = setToasts;
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts(prev => prev.slice(1)), 3500);
    return () => clearTimeout(t);
  }, [toasts]);
  return (
    <div className="toast">
      {toasts.map(t => (
        <div key={t.id} className={`toast-item toast-${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

// ========================= STATUS/PRIORITY ICONS =========================
const StatusIcon = ({ status, size = 16 }) => {
  const s = { width: size, height: size, flexShrink: 0 };
  if (status === 'done') return <svg style={s} viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (status === 'in_progress') return <svg style={s} viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/><path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  return <svg style={s} viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2"/></svg>;
};

// ========================= TASK FORM MODAL =========================
function TaskModal({ task, onClose, onSaved, token }) {
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [status, setStatus] = useState(task?.status || 'todo');
  const [tagsInput, setTagsInput] = useState(task?.tags?.join(', ') || '');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    try {
      const payload = { title, description, priority, status, tags };
      if (task) {
        await axios.put(`${API_BASE}/tasks/${task._id}`, payload, { headers: { Authorization: `Bearer ${token}` } });
        toast.success('Task updated');
      } else {
        await axios.post(`${API_BASE}/tasks`, payload, { headers: { Authorization: `Bearer ${token}` } });
        toast.success('Task created');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{task ? 'Edit task' : 'New task'}</div>
        <form onSubmit={submit}>
          <div className="form-group">
            <label className="form-label">Title *</label>
            <input required value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to be done?" />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional details…" style={{ resize: 'vertical' }} />
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)}>
                <option value="todo">Todo</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Tags (comma-separated)</label>
            <input value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="work, urgent, personal" />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <span className="spinner" /> : task ? 'Save changes' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ========================= TASK ROW =========================
function TaskRow({ task, onCycle, onEdit, onDelete }) {
  const nextStatus = { todo: 'in_progress', in_progress: 'done', done: 'todo' };
  return (
    <div className="card task-row" style={{ marginBottom: 8 }}>
      <button className="cycle-btn" onClick={() => onCycle(task, nextStatus[task.status])} title="Cycle status" aria-label="Cycle status">
        <StatusIcon status={task.status} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontWeight: 500, fontSize: 15,
            textDecoration: task.status === 'done' ? 'line-through' : 'none',
            color: task.status === 'done' ? 'var(--muted-fg)' : 'var(--primary)'
          }}>{task.title}</span>
          <span className={`badge badge-${task.priority}`}>{task.priority}</span>
          <span className={`badge badge-${task.status}`}>{task.status.replace('_', ' ')}</span>
        </div>
        {task.description && (
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--muted-fg)', lineHeight: 1.5 }}>{task.description}</p>
        )}
        {task.tags?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {task.tags.map(t => <span key={t} className="tag-chip">{t}</span>)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button className="btn-ghost btn-sm" onClick={() => onEdit(task)}>Edit</button>
        <button className="btn-ghost btn-sm delete-btn" style={{ color: 'var(--destructive)' }} onClick={() => onDelete(task)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M6 4V2h4v2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>
    </div>
  );
}

// ========================= METRICS PAGE =========================
function MetricsPage({ token, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/metrics-json`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load metrics');
    }
  }, [token]);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const formatUptime = (s) => {
    if (!s) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2.5rem', color: 'var(--primary)' }}>Gateway Metrics</h1>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--muted-fg)' }}>
            Live request rate, errors, and latency — auto-refreshes every 5s.{' '}
            Prometheus scrape: <code style={{ background: 'var(--muted)', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>/api/metrics</code>
          </p>
        </div>
        <button className="btn-outline" onClick={onBack}>← Back to tasks</button>
      </div>

      {error && <div style={{ padding: 16, background: 'oklch(0.95 0.04 25)', borderRadius: 'var(--radius)', color: 'var(--destructive)', marginBottom: 20 }}>{error}</div>}
      {!data && !error && <p style={{ color: 'var(--muted-fg)' }}>Loading metrics…</p>}

      {data && <>
        <div className="metrics-grid" style={{ marginBottom: 32 }}>
          {[
            { label: 'Req/s (60s avg)', value: data.last60s.rps?.toFixed(2) ?? '0.00' },
            { label: 'Requests (60s)', value: data.last60s.requests ?? 0 },
            { label: 'Error rate', value: `${((data.errorRate || 0) * 100).toFixed(2)}%`, danger: (data.errorRate || 0) > 0.05 },
            { label: 'Uptime', value: formatUptime(data.uptimeSec) }
          ].map(({ label, value, danger }) => (
            <div key={label} className="card metric-card">
              <div className="metric-label">{label}</div>
              <div className={`metric-value${danger ? ' danger' : ''}`}>{value}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem' }}>Requests by route</h2>
          </div>
          <table className="stats-table">
            <thead>
              <tr>
                <th>Method</th><th>Route</th><th>Status</th>
                <th style={{ textAlign: 'right' }}>Count</th>
                <th style={{ textAlign: 'right' }}>Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {(!data.perRoute || data.perRoute.length === 0) && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted-fg)', padding: '32px 14px' }}>No requests recorded yet.</td></tr>
              )}
              {(data.perRoute || []).map((r, i) => (
                <tr key={i}>
                  <td>{r.method}</td>
                  <td>{r.route}</td>
                  <td><span className={`badge ${r.status >= 500 ? 'badge-high' : r.status >= 400 ? 'badge-medium' : 'badge-done'}`}>{r.status}</span></td>
                  <td style={{ textAlign: 'right' }}>{r.count}</td>
                  <td style={{ textAlign: 'right' }}>{r.avgMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
    </div>
  );
}

// ========================= MAIN APP =========================
function App() {
  useEffect(() => { injectStyles(); }, []);

  const [token, setToken] = useState(localStorage.getItem('token'));
  const [currentUser, setCurrentUser] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);

  // Auth form state
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Task UI state
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState(null);
  const [taskModal, setTaskModal] = useState(null); // null | 'new' | taskObj
  const [page, setPage] = useState('tasks'); // 'tasks' | 'metrics'

  // Decode token to get user info
  useEffect(() => {
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setCurrentUser({ username: payload.username, role: payload.role, id: payload.id });
      } catch {
        setToken(null);
        localStorage.removeItem('token');
      }
    }
  }, [token]);

  // Handle OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('token');
    if (oauthToken) {
      localStorage.setItem('token', oauthToken);
      setToken(oauthToken);
      window.history.replaceState({}, document.title, window.location.pathname);
      toast.success('Signed in with Google');
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await axios.get(`${API_BASE}/tasks`, { headers: { Authorization: `Bearer ${token}` } });
      setTasks(res.data);
    } catch (err) {
      if (err.response?.status === 401) handleLogout();
      else toast.error('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) fetchTasks(); }, [token, fetchTasks]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    try {
      if (mode === 'signup') {
        await axios.post(`${API_BASE}/auth/register`, { username, password });
        toast.success('Account created — please sign in');
        setMode('signin');
        setPassword('');
      } else {
        const res = await axios.post(`${API_BASE}/auth/login`, { username, password });
        localStorage.setItem('token', res.data.token);
        setToken(res.data.token);
        toast.success(`Welcome back, ${res.data.user.username}!`);
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Authentication failed';
      toast.error(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setCurrentUser(null);
    setTasks([]);
    setPage('tasks');
    toast.success('Signed out');
  };

  const cycleStatus = async (task, newStatus) => {
    try {
      await axios.put(`${API_BASE}/tasks/${task._id}`, { ...task, status: newStatus }, { headers: { Authorization: `Bearer ${token}` } });
      fetchTasks();
    } catch { toast.error('Failed to update task'); }
  };

  const deleteTask = async (task) => {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    try {
      await axios.delete(`${API_BASE}/tasks/${task._id}`, { headers: { Authorization: `Bearer ${token}` } });
      toast.success('Task deleted');
      fetchTasks();
    } catch { toast.error('Failed to delete task'); }
  };

  const allTags = [...new Set(tasks.flatMap(t => t.tags || []))];
  const filtered = tasks.filter(t => {
    if (filter !== 'all' && t.status !== filter) return false;
    if (tagFilter && !(t.tags || []).includes(tagFilter)) return false;
    return true;
  });
  const counts = {
    todo: tasks.filter(t => t.status === 'todo').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length
  };

  // ========================= RENDER: AUTH =========================
  if (!token) {
    return (
      <>
        <ToastContainer />
        <div style={{ display: 'grid', minHeight: '100vh', gridTemplateColumns: window.innerWidth > 768 ? '1fr 1fr' : '1fr' }}>
          {/* Left panel */}
          <div style={{ background: 'var(--primary)', padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, background: 'var(--accent)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--primary)', fontWeight: 600 }}>T</span>
              </div>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', color: 'var(--primary-fg)', fontWeight: 600 }}>Tasken</span>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '2.4rem', lineHeight: 1.25, color: 'var(--accent)', fontWeight: 600 }}>
                "A task well-managed is a day well-lived."
              </div>
              <p style={{ marginTop: 20, fontSize: 13, color: 'oklch(0.97 0.02 95 / 0.6)' }}>— The Tasken Manifesto</p>
            </div>
            <div style={{ fontSize: 12, color: 'oklch(0.97 0.02 95 / 0.4)' }}>Encrypted · Private · Yours alone</div>
          </div>

          {/* Right panel */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            <div style={{ width: '100%', maxWidth: 380 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2.5rem', color: 'var(--primary)', marginBottom: 8 }}>
                {mode === 'signin' ? 'Welcome back' : 'Begin your workspace'}
              </h1>
              <p style={{ fontSize: 13, color: 'var(--muted-fg)', marginBottom: 28 }}>
                {mode === 'signin' ? 'Sign in to access your tasks.' : 'Create an account in seconds.'}
              </p>

              {/* Google OAuth */}
              <button
                className="btn-outline"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24, padding: '10px 16px' }}
                onClick={() => window.location.href = `${API_BASE}/auth/oauth/google`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div className="divider" style={{ flex: 1 }} />
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--muted-fg)' }}>or</span>
                <div className="divider" style={{ flex: 1 }} />
              </div>

              <form onSubmit={handleAuth}>
                <div className="form-group">
                  <label className="form-label">Username</label>
                  <input type="text" required value={username} onChange={e => setUsername(e.target.value)} placeholder="your_username" autoComplete="username" />
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
                </div>
                {mode === 'signup' && (
                  <p style={{ fontSize: 12, color: 'var(--muted-fg)', marginBottom: 12 }}>
                    Password must be ≥8 characters and include uppercase, lowercase, a number, and a symbol.
                  </p>
                )}
                <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: 4 }} disabled={authLoading}>
                  {authLoading ? <span className="spinner" /> : mode === 'signin' ? 'Sign in' : 'Create account'}
                </button>
              </form>

              <p style={{ marginTop: 24, textAlign: 'center', fontSize: 13, color: 'var(--muted-fg)' }}>
                {mode === 'signin' ? 'New here? ' : 'Already have an account? '}
                <button type="button" style={{ background: 'none', border: 'none', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}
                  onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
                  {mode === 'signin' ? 'Create an account' : 'Sign in'}
                </button>
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ========================= RENDER: DASHBOARD =========================
  return (
    <>
      <ToastContainer />
      {taskModal && (
        <TaskModal
          task={taskModal === 'new' ? null : taskModal}
          token={token}
          onClose={() => setTaskModal(null)}
          onSaved={fetchTasks}
        />
      )}

      <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        {/* Header */}
        <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--card)' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, background: 'var(--primary)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--accent)', fontWeight: 600 }}>T</span>
              </div>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', color: 'var(--primary)', fontWeight: 600 }}>Tasken</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {currentUser?.role === 'ADMIN' && (
                <>
                  <span className="badge badge-admin">Admin</span>
                  <button className="btn-outline btn-sm" onClick={() => setPage(page === 'metrics' ? 'tasks' : 'metrics')}>
                    {page === 'metrics' ? 'Tasks' : 'Metrics'}
                  </button>
                </>
              )}
              <span style={{ fontSize: 13, color: 'var(--muted-fg)' }}>{currentUser?.username}</span>
              <button className="btn-ghost btn-sm" onClick={handleLogout} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Sign out
              </button>
            </div>
          </div>
        </header>

        {/* Main */}
        <main style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px' }}>
          {page === 'metrics' && currentUser?.role === 'ADMIN' ? (
            <MetricsPage token={token} onBack={() => setPage('tasks')} />
          ) : (
            <>
              {/* Title row */}
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32 }}>
                <div>
                  <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '3rem', color: 'var(--primary)' }}>Your tasks</h1>
                  <p style={{ marginTop: 4, fontSize: 13, color: 'var(--muted-fg)' }}>
                    {tasks.length} total · {counts.todo} todo · {counts.in_progress} active · {counts.done} done
                  </p>
                </div>
                <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => setTaskModal('new')}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  New task
                </button>
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 24 }}>
                {['all', 'todo', 'in_progress', 'done'].map(f => (
                  <button key={f} className={`filter-btn ${filter === f ? 'filter-active' : 'filter-inactive'}`}
                    onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : f === 'in_progress' ? 'In progress' : f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
                {allTags.length > 0 && (
                  <>
                    <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--muted-fg)' }}>
                      <path d="M1 1h6l7 7-6 6-7-7V1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                      <circle cx="4" cy="4" r="1" fill="currentColor"/>
                    </svg>
                    {allTags.map(tag => (
                      <span key={tag} className={`badge ${tagFilter === tag ? 'badge-in_progress' : 'badge-todo'}`}
                        style={{ cursor: 'pointer' }} onClick={() => setTagFilter(tagFilter === tag ? null : tag)}>
                        {tag}
                      </span>
                    ))}
                  </>
                )}
              </div>

              {/* Task list */}
              {loading && tasks.length === 0 ? (
                <p style={{ color: 'var(--muted-fg)' }}>Loading tasks…</p>
              ) : filtered.length === 0 ? (
                <div className="empty-state">
                  <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.8rem', color: 'var(--primary)' }}>
                    {tasks.length === 0 ? 'No tasks yet' : 'No matching tasks'}
                  </p>
                  <p style={{ marginTop: 8, fontSize: 13, color: 'var(--muted-fg)' }}>
                    {tasks.length === 0 ? 'Create your first task to begin.' : 'Try changing the filter.'}
                  </p>
                </div>
              ) : (
                filtered.map(task => (
                  <TaskRow
                    key={task._id}
                    task={task}
                    onCycle={cycleStatus}
                    onEdit={t => setTaskModal(t)}
                    onDelete={deleteTask}
                  />
                ))
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}

export default App;
