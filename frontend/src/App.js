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
    <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif', maxWidth: '900px' }}>
      <h1>Task Manager Microservice</h1>

      {!token ? (
        /* ====================== AUTH FORM ====================== */
        <div style={{ maxWidth: '400px' }}>
          <div style={{ marginBottom: '20px' }}>
            <button 
              onClick={() => setIsLogin(true)} 
              style={{ marginRight: '15px', fontWeight: isLogin ? 'bold' : 'normal' }}
            >
              Login
            </button>
            <button 
              onClick={() => setIsLogin(false)} 
              style={{ fontWeight: !isLogin ? 'bold' : 'normal' }}
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
              style={{ display: 'block', width: '100%', padding: '10px', margin: '10px 0' }}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ display: 'block', width: '100%', padding: '10px', margin: '10px 0' }}
              required
            />
            {!isLogin && (
              <p style={{ margin: '0 0 10px', fontSize: '0.9rem', color: '#555' }}>
                Password must be at least 6 characters and include uppercase, lowercase, number, and symbol.
              </p>
            )}
            {isLogin && (
              <button
                type="button"
                onClick={() => window.location.href = `${API_BASE}/auth/oauth/google`}
                style={{ display: 'block', width: '100%', padding: '10px', margin: '10px 0', background: '#4285F4', color: 'white', border: 'none', cursor: 'pointer' }}
              >
                Sign in with Google
              </button>
            )}

            {!isLogin && (
              <select 
                value={role} 
                onChange={(e) => setRole(e.target.value)}
                style={{ display: 'block', width: '100%', padding: '10px', margin: '10px 0' }}
              >
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
              </select>
            )}

            <button type="submit" style={{ padding: '12px 24px', marginTop: '10px', width: '100%' }}>
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
            <button onClick={fetchTasks}>Refresh Tasks</button>
            <button 
              onClick={logout}
              style={{ background: '#dc3545', color: 'white', border: 'none', padding: '8px 16px', cursor: 'pointer' }}
            >
              Logout
            </button>
          </div>

          <form onSubmit={createTask} style={{ marginBottom: '30px' }}>
            <input 
              value={title} 
              onChange={(e) => setTitle(e.target.value)} 
              placeholder="Enter new task title" 
              required 
              style={{ padding: '10px', width: '350px', marginRight: '10px' }}
            />
            <button type="submit" style={{ padding: '10px 20px' }}>Add Task</button>
          </form>

          <h3>My Tasks ({tasks.length})</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {tasks.map(task => (
              <li key={task._id} style={{ 
                padding: '12px', 
                margin: '8px 0', 
                background: '#f8f9fa',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                {editingId === task._id ? (
                  <div style={{ flex: 1 }}>
                    <input 
                      value={editTitle} 
                      onChange={(e) => setEditTitle(e.target.value)}
                      style={{ width: '65%', padding: '8px' }}
                    />
                    <button onClick={() => saveEdit(task._id)} style={{ marginLeft: '8px' }}>Save</button>
                    <button onClick={() => { setEditingId(null); setEditTitle(''); }} style={{ marginLeft: '8px' }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <span style={{ flex: 1 }}>{task.title}</span>
                    <div>
                      <button onClick={() => startEditing(task)} style={{ marginRight: '8px' }}>Edit</button>
                      <button onClick={() => deleteTask(task._id)} style={{ color: 'red' }}>Delete</button>
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
  );
}

export default App;
