import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import DriverTracker from "./DriverTracker";
import AdminHome from "./AdminHome";

const DRIVER_ONLY = import.meta.env.VITE_DRIVER_ONLY === "true";

function Login({ onLogged }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [msg, setMsg] = useState("");

  async function entrar() {
    setMsg("");
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: senha,
    });
    if (error) return setMsg(error.message);
    onLogged(data.user);
  }

  return (
    <div style={{ fontFamily: "Arial", padding: 16, maxWidth: 420 }}>
      <h2>Login</h2>

      <input
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ width: "100%", padding: 10, marginBottom: 8 }}
      />

      <input
        placeholder="Senha"
        type="password"
        value={senha}
        onChange={(e) => setSenha(e.target.value)}
        style={{ width: "100%", padding: 10, marginBottom: 8 }}
      />

      <button onClick={entrar} style={{ padding: "10px 14px" }}>
        Entrar
      </button>

      {msg && <p style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    async function loadRole() {
      if (!user) {
        setRole(null);
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (error) {
        setRole(null);
        return;
      }

      setRole(data.role);
    }

    loadRole();
  }, [user]);

  if (!user) return <Login onLogged={setUser} />;
  if (!role) return <div style={{ padding: 16 }}>Carregando perfil...</div>;
  if (DRIVER_ONLY) return <DriverTracker />;

  return role === "admin" ? <AdminHome /> : <DriverTracker />;
}
