import React, { useState, useEffect } from 'react';
// **CORRECCIÓN**: Se eliminaron todas las importaciones de Firebase que ya no se usan en el frontend.
import { db, auth } from './firebase/config';
import { collection, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';

// Vistas y Componentes
import Sidebar from './components/Sidebar';
import Modal from './components/Modal';
import LoginScreen from './views/LoginScreen';
import ServerSelectionScreen from './views/ServerSelectionScreen';
import ApplicationsList from './views/ApplicationsList';
import ApplicationReview from './views/ApplicationReview';
import ApplicationForm from './views/ApplicationForm';
import FormList from './views/FormList';
import FormEditor from './views/FormEditor';
import Settings from './views/Settings';

function App() {
    // Estados de autenticación y selección de servidor
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [guilds, setGuilds] = useState([]);
    const [loadingGuilds, setLoadingGuilds] = useState(false);
    const [selectedGuild, setSelectedGuild] = useState(null);

    // Estados de la dashboard
    const [applications, setApplications] = useState([]);
    const [forms, setForms] = useState([]);
    const [view, setView] = useState('applications');
    const [selectedApp, setSelectedApp] = useState(null);
    const [editingForm, setEditingForm] = useState(null);
    const [modal, setModal] = useState({ show: false, text: '' });

    const handleLogout = () => auth.signOut();

    // --- EFECTOS DE CICLO DE VIDA ---
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');
        if (token) {
            signInWithCustomToken(auth, token).finally(() => window.history.replaceState({}, document.title, "/"));
        }
        const unsubscribeAuth = onAuthStateChanged(auth, u => {
            setUser(u);
            setLoading(false);
            if (!u) {
                setSelectedGuild(null);
                setGuilds([]);
            }
        });
        return () => unsubscribeAuth();
    }, []);

    useEffect(() => {
        if (user && guilds.length === 0 && !loadingGuilds) {
            setLoadingGuilds(true);
            user.getIdToken()
                .then(idToken => fetch(`${process.env.REACT_APP_BACKEND_URL}/api/guilds`, { headers: { 'Authorization': `Bearer ${idToken}` } }))
                .then(res => {
                    if (res.status === 429) {
                         setModal({show: true, text: 'Has hecho demasiadas peticiones. Por favor, espera unos minutos y reinicia sesión.'});
                         return Promise.reject(new Error('Rate Limited'));
                    }
                    if (!res.ok) return res.json().then(err => Promise.reject(err));
                    return res.json();
                })
                .then(data => setGuilds(data))
                .catch(error => { 
                    console.error("Guilds Fetch Error:", error.message || error); 
                    if (String(error.message).includes('401')) {
                        setModal({show: true, text: 'Tu sesión de Discord ha expirado. Por favor, cierra sesión y vuelve a entrar.'});
                    }
                })
                .finally(() => setLoadingGuilds(false));
        }
    }, [user, guilds.length, loadingGuilds]);

    useEffect(() => {
        if (!selectedGuild) return;
        const guildId = selectedGuild.id;
        // La lectura de datos sigue ocurriendo en tiempo real desde el frontend
        const appsPath = `guilds/${guildId}/applications`;
        const formsPath = `guilds/${guildId}/forms`;

        const unsubApps = onSnapshot(collection(db, appsPath), snapshot => {
            const appsData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            if (appsData.some(app => app.date)) appsData.sort((a, b) => (b.date?.seconds || 0) - (a.date?.seconds || 0));
            setApplications(appsData);
        });
        const unsubForms = onSnapshot(collection(db, formsPath), snapshot => setForms(snapshot.docs.map(d => ({ id: d.id, ...d.data() }))));
        return () => { unsubApps(); unsubForms(); };
    }, [selectedGuild]);

    // --- MANEJADORES ---
    const handleSelectGuild = (guild) => {
        setSelectedGuild(guild);
        setView(guild.isAdmin ? 'applications' : 'submitForm');
    };
    const handleBackToGuilds = () => setSelectedGuild(null);
    const handleSelectApp = (app) => {
        setSelectedApp(app);
        setView('review');
    };

    // --- LÓGICA DE NEGOCIO (Mediante API) ---
    const apiRequest = async (endpoint, method, body) => {
        if (!user) throw new Error("Usuario no autenticado.");
        const idToken = await user.getIdToken();
        const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}${endpoint}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: body ? JSON.stringify(body) : undefined
        });
        const resData = await response.json();
        if (!response.ok) throw new Error(resData.message || 'Ocurrió un error en el servidor.');
        return resData;
    };

    const handleApplicationSubmit = async (answers, form) => {
        try {
            await apiRequest(`/api/guilds/${selectedGuild.id}/applications`, 'POST', { submission: { userId: user.uid, userName: user.displayName, userAvatar: user.photoURL, formId: form.id, formTitle: form.title, questions: form.questions.map(q => ({...q, answer: answers[q.id] || '' })) } });
            if (form.notificationChannelId) {
                const embed = { title: `Nueva Postulación Recibida: ${form.title}`, description: `Enviada por **${user.displayName}**.`, color: 0x5865F2, timestamp: new Date().toISOString() };
                await apiRequest(`/api/send-webhook`, 'POST', { channelId: form.notificationChannelId, embed });
            }
            setModal({show: true, text: "Tu postulación fue enviada correctamente."});
            setView('submitForm');
        } catch(error) { setModal({ show: true, text: `Error: ${error.message}` }); }
    };

    const handleApplicationDecision = async (decision, application, sendDm) => {
        try {
            await apiRequest(`/api/guilds/${selectedGuild.id}/applications/${application.id}`, 'PUT', { status: decision });
            let finalModalMessage = `Decisión guardada.`;
            const formUsed = forms.find(f => f.id === application.formId);

            if (decision === 'Accepted' && selectedGuild.isPremium && formUsed?.rolesToAssign?.length > 0) {
                 await apiRequest(`/api/assign-roles`, 'POST', { guildId: selectedGuild.id, memberId: application.userId, roles: formUsed.rolesToAssign.filter(r => r) });
                 finalModalMessage += ' Roles asignados.';
            }
            if (sendDm) {
                const serverName = guilds.find(g => g.id === selectedGuild.id)?.name || 'el servidor';
                let message = `¡Hola! Tu postulación para "${application.formTitle}" en **${serverName}** ha sido **${decision === 'Accepted' ? 'Aceptada' : 'Rechazada'}**.`;
                await apiRequest(`/api/notify-user`, 'POST', { memberId: application.userId, message });
                finalModalMessage += ' Notificación enviada.';
            }
            setModal({ show: true, text: finalModalMessage });
            setView('applications');
        } catch (error) { setModal({ show: true, text: `Error: ${error.message}` }); }
    };
    
    const handleSaveForm = async (formToSave) => {
        try {
            const endpoint = formToSave.id ? `/api/guilds/${selectedGuild.id}/forms/${formToSave.id}` : `/api/guilds/${selectedGuild.id}/forms`;
            const method = formToSave.id ? 'PUT' : 'POST';
            await apiRequest(endpoint, method, { form: formToSave });
            setEditingForm(null); setView('forms'); setModal({ show: true, text: 'Formulario guardado.' });
        } catch (error) { setModal({ show: true, text: `Error: ${error.message}` }); }
    };
    
    const handleDeleteForm = async (formId) => {
        if (window.confirm("¿Seguro que quieres eliminar este formulario?")) {
            try {
                await apiRequest(`/api/guilds/${selectedGuild.id}/forms/${formId}`, 'DELETE');
                setModal({ show: true, text: "Formulario eliminado." });
            } catch (error) { setModal({ show: true, text: `Error: ${error.message}` }); }
        }
    };
    
    const handleActivatePremium = async (isPremium) => {
        try {
            await apiRequest(`/api/set-premium`, 'POST', { guildId: selectedGuild.id, isPremium });
            setSelectedGuild(g => ({...g, isPremium}));
            setModal({show: true, text: `Plan Premium ${isPremium ? 'activado' : 'desactivado'}.`});
        } catch(error) { setModal({show: true, text: `Error: ${error.message}`}); }
    };

    // --- RENDERIZADO CONDICIONAL ---
    const renderDashboardView = () => {
        if (!selectedGuild) return null;
        const canAccessAdminView = selectedGuild.isAdmin;
        switch (view) {
            case 'applications': return canAccessAdminView ? <ApplicationsList applications={applications} onSelectApp={handleSelectApp} /> : <p>No tienes permiso.</p>;
            case 'review': return canAccessAdminView ? <ApplicationReview app={selectedApp} onDecision={(decision, sendDm) => handleApplicationDecision(decision, selectedApp, sendDm)} /> : <p>No tienes permiso.</p>;
            case 'forms': return canAccessAdminView ? <FormList forms={forms} onEditForm={(f) => {setEditingForm(f); setView('editForm');}} onCreateForm={() => {setEditingForm(null); setView('editForm')}} onDeleteForm={handleDeleteForm} /> : <p>No tienes permiso.</p>;
            case 'editForm': return canAccessAdminView ? <FormEditor initialForm={editingForm} onSave={handleSaveForm} onCancel={() => setView('forms')} isPremium={selectedGuild.isPremium} guildId={selectedGuild.id} user={user} /> : <p>No tienes permiso.</p>;
            case 'submitForm': return <ApplicationForm forms={forms} onSubmit={handleApplicationSubmit} />;
            case 'settings': return canAccessAdminView ? <Settings guild={selectedGuild} onActivatePremium={handleActivatePremium}/> : <p>No tienes permiso.</p>;
            default: return <p>Vista no encontrada.</p>;
        }
    };
    
    if (loading) return <div className="flex justify-center items-center h-screen bg-main"><p>Verificando sesión...</p></div>;
    if (!user) return <LoginScreen />;
    if (!selectedGuild) return <ServerSelectionScreen guilds={guilds} user={user} onSelectGuild={handleSelectGuild} onLogout={handleLogout} loading={loadingGuilds} />;
    
    return (
        <div className="flex h-screen bg-main text-main-text">
            {modal.show && <Modal text={modal.text} onClose={() => setModal({ show: false, text: '' })} />}
            <Sidebar setView={setView} activeView={view} user={user} isAdmin={selectedGuild.isAdmin} onLogout={handleLogout} onBack={handleBackToGuilds}/>
            <main className="flex-1 p-6 md:p-10 overflow-y-auto">{renderDashboardView()}</main>
        </div>
    );
}

export default App;

