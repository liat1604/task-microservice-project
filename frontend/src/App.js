import { useState, useEffect } from 'react';
import axios from 'axios';

const API_BASE = 'http://localhost:8080/api';

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');

  // Auth states
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('USER');

  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const palette = {
    bg: '#f4f6fb',
    card: '#ffffff',
    primary: '#2563eb',
    danger: '#dc3545',
    muted: '#6b7280'
  };

  const styles = {
    app: { padding: '30px', fontFamily: 'Segoe UI, Roboto, Arial, sans-serif', minHeight: '100vh', background: palette.bg, display: 'flex', justifyContent: 'center' },
    wrapper: { width: '100%', maxWidth: '980px' },
    header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' },
    title: { margin: 0, fontSize: '1.6rem' },
    subtitle: { margin: 0, color: palette.muted, fontSize: '0.95rem' },
    card: { background: palette.card, padding: '24px', borderRadius: '12px', boxShadow: '0 6px 18px rgba(32,33,36,0.08)' },
    formInput: { display: 'block', width: '100%', padding: '10px', margin: '10px 0', borderRadius: '8px', border: '1px solid #e5e7eb' },
    buttonPrimary: { padding: '10px 16px', background: palette.primary, color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' },
    buttonSecondary: { padding: '8px 14px', background: '#f3f4f6', color: '#111827', border: 'none', borderRadius: '8px', cursor: 'pointer' },
    googleButton: { display: 'block', width: '100%', padding: '10px', margin: '10px 0', background: '#4285F4', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' },
    taskItem: { padding: '12px', margin: '8px 0', background: '#fbfdff', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid #eef2ff' },
    smallButton: { marginLeft: '8px', padding: '6px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer' }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      localStorage.setItem('token', token);
      setToken(token);
      window.history.replaceState({}, document.title, window.location.pathname);
      setMessage('✅ Logged in with OAuth');
    }
  }, []);

  // ====================== AUTH ======================
  const register = async (e) => {
    e.preventDefault();
    setMessage(''); setError('');
    try {
      const res = await axios.post(`${API_BASE}/auth/register`, {
        username,
        password,
        role
      });
      setMessage(`✅ ${res.data.message}`);
      setUsername('');
      setPassword('');
      setIsLogin(true);
    } catch (err) {
      const serverError = err.response?.data?.error
        || err.response?.data?.errors?.[0]?.msg
        || 'Registration failed';
      setError(serverError);
    }
  };

  const login = async (e) => {
    e.preventDefault();
    setMessage(''); setError('');
    try {
      const res = await axios.post(`${API_BASE}/auth/login`, { username, password });
      localStorage.setItem('token', res.data.token);
      setToken(res.data.token);
      setMessage(`✅ Logged in as ${res.data.user.username}`);
      fetchTasks();
    } catch (err) {
      const serverError = err.response?.data?.error || 'Invalid username or password';
      setError(serverError);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setTasks([]);
    setMessage('👋 Logged out successfully');
    setError('');
  };

  // ====================== TASKS ======================
  const fetchTasks = async () => {
    try {
      const res = await axios.get(`${API_BASE}/tasks`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTasks(res.data);
    } catch (err) {
      setError('Failed to load tasks');
    }
  };

  const createTask = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await axios.post(`${API_BASE}/tasks`, { title }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTitle('');
      setMessage('✅ Task created successfully');
      fetchTasks();
    } catch (err) {
      setError('Failed to create task');
    }
  };

  const startEditing = (task) => {
    setEditingId(task._id);
    setEditTitle(task.title);
  };

  const saveEdit = async (id) => {
    try {
      await axios.put(`${API_BASE}/tasks/${id}`, { title: editTitle }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setEditingId(null);
      setEditTitle('');
      setMessage('✅ Task updated successfully');
      fetchTasks();
    } catch (err) {
      setError('Failed to update task');
    }
  };

  const deleteTask = async (id) => {
    if (!window.confirm('Are you sure you want to delete this task?')) return;
    try {
      await axios.delete(`${API_BASE}/tasks/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessage('✅ Task deleted successfully');
      fetchTasks();
    } catch (err) {
      setError('Failed to delete task');
    }
  };

  return (
    <div style={styles.app}>
      <div style={styles.wrapper}>
        <div style={styles.header}>
          <div style={{ fontSize: '1.8rem' }}>🗂️</div>
          <div>
            <h1 style={styles.title}>Task Manager Microservice</h1>
            <p style={styles.subtitle}>Lightweight task service with auth, roles, and metrics</p>
          </div>
        </div>

        <div style={styles.card}>

          {!token ? (
        /* ====================== AUTH FORM ====================== */
          <div style={{ maxWidth: '480px' }}>
            <div style={{ marginBottom: '18px', display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setIsLogin(true)}
                style={{ ...styles.buttonSecondary, fontWeight: isLogin ? '600' : '400' }}
              >
                Login
              </button>
              <button
                onClick={() => setIsLogin(false)}
                style={{ ...styles.buttonSecondary, fontWeight: !isLogin ? '600' : '400' }}
              >
                Register
              </button>
            </div>

            <form onSubmit={isLogin ? login : register}>
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={styles.formInput}
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={styles.formInput}
                required
              />
              {!isLogin && (
                <p style={{ margin: '0 0 10px', fontSize: '0.9rem', color: palette.muted }}>
                  Password must be at least 6 characters and include uppercase, lowercase, number, and symbol.
                </p>
              )}
              {isLogin && (
                <button
                  type="button"
                  onClick={() => window.location.href = `${API_BASE}/auth/oauth/google`}
                  style={styles.googleButton}
                >
                  Sign in with Google
                </button>
              )}

              {!isLogin && (
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  style={styles.formInput}
                >
                  <option value="USER">User</option>
                  <option value="ADMIN">Admin</option>
                </select>
              )}

              <button type="submit" style={{ ...styles.buttonPrimary, width: '100%', marginTop: '8px' }}>
                {isLogin ? 'Login' : 'Register New User'}
              </button>
            </form>

            {message && <p style={{ color: 'green', marginTop: '15px' }}>{message}</p>}
            {error && <p style={{ color: 'red', marginTop: '15px' }}>{error}</p>}
          </div>
        ) : (
        /* ====================== TASK MANAGER UI ====================== */
          <div>
            <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={fetchTasks} style={styles.buttonSecondary}>Refresh Tasks</button>
              <button
                onClick={logout}
                style={{ ...styles.buttonPrimary, background: palette.danger }}
              >
                Logout
              </button>
            </div>

            <form onSubmit={createTask} style={{ marginBottom: '24px', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter new task title"
                required
                style={{ ...styles.formInput, flex: 1, margin: 0 }}
              />
              <button type="submit" style={styles.buttonPrimary}>Add</button>
            </form>

            <h3 style={{ marginTop: 0 }}>My Tasks ({tasks.length})</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {tasks.length === 0 && <li style={{ color: palette.muted }}>No tasks yet — add your first task above ✨</li>}
              {tasks.map(task => (
                <li key={task._id} style={styles.taskItem}>
                  {editingId === task._id ? (
                    <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        style={{ flex: 1, padding: '8px', borderRadius: '6px', border: '1px solid #e6edf8' }}
                      />
                      <button onClick={() => saveEdit(task._id)} style={{ ...styles.smallButton, background: palette.primary, color: 'white' }}>Save</button>
                      <button onClick={() => { setEditingId(null); setEditTitle(''); }} style={styles.smallButton}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{task.title}</span>
                      <div>
                        <button onClick={() => startEditing(task)} style={{ ...styles.smallButton, background: '#f3f4f6' }}>Edit</button>
                        <button onClick={() => deleteTask(task._id)} style={{ ...styles.smallButton, background: 'transparent', color: palette.danger }}>Delete</button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {message && <p style={{ color: 'green', marginTop: '15px' }}>{message}</p>}
        {error && <p style={{ color: 'red', marginTop: '15px' }}>{error}</p>}

        </div>
      </div>
    </div>
  );
}

export default App;
