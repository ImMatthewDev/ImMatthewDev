import React, { useState, useEffect, useCallback } from 'react';
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

    const handleLogout = useCallback(() => {
        auth.signOut().catch(error => console.error("Error al cerrar sesión:", error));
    }, []);

    // Función unificada para hacer peticiones seguras al backend
    const apiRequest = useCallback(async (endpoint, method, body) => {
        if (!user) throw new Error("Usuario no autenticado.");
        const idToken = await user.getIdToken(true); // Forzar refresco del token
        const response = await fetch(`${process.env.REACT_APP_BACKEND_URL}${endpoint}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: body ? JSON.stringify(body) : undefined
        });
        
        if (response.status === 401) {
            setModal({show: true, text: 'Tu sesión ha expirado. Por favor, inicia sesión de nuevo.'});
            handleLogout();
            throw new Error("Sesión expirada");
        }

        const resData = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(resData.message || 'Ocurrió un error en el servidor.');
        return resData;
    }, [user, handleLogout]);

    // --- EFECTOS DE CICLO DE VIDA ---
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('token');
        const error = params.get('error');

        if (error) {
            setModal({ show: true, text: `Error de autenticación: ${error.replace(/_/g, ' ')}` });
            setLoading(false);
            window.history.replaceState({}, document.title, "/login");
            return;
        }

        if (token) {
            signInWithCustomToken(auth, token)
                .catch(err => { console.error("Token Error:", err); setModal({ show: true, text: "Token de inicio de sesión inválido." }); })
                .finally(() => window.history.replaceState({}, document.title, "/"));
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
        const fetchGuilds = async () => {
            if (!user || guilds.length > 0) return;
            setLoadingGuilds(true);
            try {
                const data = await apiRequest('/api/guilds', 'GET');
                setGuilds(data);
            } catch (error) {
                if (error.message !== "Sesión expirada") {
                    console.error("Error al obtener servidores:", error.message);
                    setModal({show: true, text: `Error: ${error.message}`});
                }
            } finally {
                setLoadingGuilds(false);
            }
        };
        fetchGuilds();
    }, [user, guilds.length, apiRequest]);

    useEffect(() => {
        if (!selectedGuild) return;
        const guildId = selectedGuild.id;
        const appsPath = `guilds/${guildId}/applications`;
        const formsPath = `guilds/${guildId}/forms`;

        const unsubApps = onSnapshot(collection(db, appsPath), s => setApplications(s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a,b) => (b.date?.seconds || 0) - (a.date?.seconds || 0))));
        const unsubForms = onSnapshot(collection(db, formsPath), s => setForms(s.docs.map(d => ({ ...d.data(), id: d.id }))));
        return () => { unsubApps(); unsubForms(); };
    }, [selectedGuild]);

    // --- MANEJADORES ---
    const handleSelectGuild = (guild) => { setSelectedGuild(guild); setView(guild.isAdmin ? 'applications' : 'submitForm'); };
    const handleBackToGuilds = () => setSelectedGuild(null);
    const handleSelectApp = (app) => { setSelectedApp(app); setView('review'); };

    // --- LÓGICA DE NEGOCIO ---
    const handleApplicationSubmit = async (answers, form) => {
        if (!user || !form || !selectedGuild) return;
        try {
            const submission = { userId: user.uid, userName: user.displayName, userAvatar: user.photoURL, formId: form.id, formTitle: form.title, questions: form.questions.map(q => ({...q, answer: answers[q.id] || '' }))};
            await apiRequest(`/api/guilds/${selectedGuild.id}/applications`, 'POST', { submission });
            setModal({show: true, text: "Tu postulación fue enviada correctamente."});
            setView('submitForm');
        } catch(error) { setModal({ show: true, text: `Error: ${error.message}` }); }
    };

    const handleApplicationDecision = async (decision, application, sendDm) => {
        if (!application || !selectedGuild || !user) return;
        try {
            await apiRequest(`/api/guilds/${selectedGuild.id}/applications/${application.id}`, 'PUT', { guildId: selectedGuild.id, status: decision });
            let finalModalMessage = `Decisión guardada.`;
            const formUsed = forms.find(f => f.id === application.formId);

            const rolesToAdd = (decision === 'Accepted' && formUsed?.rolesOnAccept) || [];
            const rolesToRemove = (decision === 'Rejected' && formUsed?.rolesOnReject) || [];
            
            if (selectedGuild.isPremium && rolesToAdd.length > 0) {
                 await apiRequest(`/api/assign-roles`, 'POST', { guildId: selectedGuild.id, memberId: application.userId, roles: rolesToAdd.filter(r => r) });
                 finalModalMessage += ' Roles de aceptación asignados.';
            } else if (decision === 'Accepted' && formUsed?.roleToAssign) {
                 await apiRequest(`/api/assign-roles`, 'POST', { guildId: selectedGuild.id, memberId: application.userId, roles: [formUsed.roleToAssign] });
                 finalModalMessage += ' Rol asignado.';
            }

            if (selectedGuild.isPremium && rolesToRemove.length > 0) {
                 await apiRequest(`/api/remove-roles`, 'POST', { guildId: selectedGuild.id, memberId: application.userId, roles: rolesToRemove.filter(r => r) });
                 finalModalMessage += ' Roles de rechazo quitados.';
            }

            if (sendDm) {
                const serverName = guilds.find(g => g.id === selectedGuild.id)?.name || 'el servidor';
                const template = decision === 'Accepted' ? formUsed?.dmTemplateAccept : formUsed?.dmTemplateReject;
                const message = (selectedGuild.isPremium && template) ? template.replace(/{userName}/g, application.userName).replace(/{serverName}/g, serverName).replace(/{formTitle}/g, application.formTitle) : `¡Hola! Tu postulación para el formulario "${application.formTitle}" en **${serverName}** ha sido **${decision === 'Accepted' ? 'Aceptada' : 'Rechazada'}**.`;
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
            try { await apiRequest(`/api/guilds/${selectedGuild.id}/forms/${formId}`, 'DELETE'); setModal({ show: true, text: "Formulario eliminado." }); }
            catch (error) { setModal({ show: true, text: `Error: ${error.message}` }); }
        }
    };
    
    const handleActivatePremium = async (isPremium) => {
        try { await apiRequest(`/api/set-premium`, 'POST', { guildId: selectedGuild.id, isPremium }); setSelectedGuild(g => ({...g, isPremium})); setModal({show: true, text: `Plan Premium ${isPremium ? 'activado' : 'desactivado'}.`}); }
        catch(error) { setModal({show: true, text: `Error: ${error.message}`}); }
    };

    // --- RENDERIZADO CONDICIONAL (COMPLETO Y FUNCIONAL) ---
    const renderDashboardView = () => {
        if (!selectedGuild) return null;
        const canAccessAdminView = selectedGuild.isAdmin;
        switch (view) {
            case 'applications':
                return canAccessAdminView ? <ApplicationsList applications={applications} onSelectApp={handleSelectApp} /> : <p>No tienes permiso para ver esta página.</p>;
            case 'review':
                return canAccessAdminView ? <ApplicationReview app={selectedApp} onDecision={handleApplicationDecision} /> : <p>No tienes permiso para ver esta página.</p>;
            case 'forms':
                return canAccessAdminView ? <FormList forms={forms} onEditForm={(f) => {setEditingForm(f); setView('editForm');}} onCreateForm={() => {setEditingForm(null); setView('editForm')}} onDeleteForm={handleDeleteForm} /> : <p>No tienes permiso para ver esta página.</p>;
            case 'editForm':
                return canAccessAdminView ? <FormEditor initialForm={editingForm} onSave={handleSaveForm} onCancel={() => setView('forms')} isPremium={selectedGuild.isPremium} guildId={selectedGuild.id} user={user} /> : <p>No tienes permiso para ver esta página.</p>;
            case 'submitForm':
                return <ApplicationForm forms={forms} onSubmit={handleApplicationSubmit} />;
            case 'settings':
                return canAccessAdminView ? <Settings guild={selectedGuild} onActivatePremium={handleActivatePremium}/> : <p>No tienes permiso para ver esta página.</p>;
            default:
                return <p>Vista no encontrada.</p>;
        }
    };
    
    if (loading) return <div className="flex justify-center items-center h-screen bg-main"><p>Verificando sesión...</p></div>;
    if (!user) return <LoginScreen />;
    if (!selectedGuild) return <ServerSelectionScreen guilds={guilds} user={user} onSelectGuild={handleSelectGuild} onLogout={handleLogout} loading={loadingGuilds} onRefresh={useCallback(() => setGuilds([]), [])}/>;
    
    return (
        <div className="flex h-screen bg-main text-main-text">
            {modal.show && <Modal text={modal.text} onClose={() => setModal({ show: false, text: '' })} />}
            <Sidebar setView={setView} activeView={view} user={user} isAdmin={selectedGuild.isAdmin} onLogout={handleLogout} onBack={handleBackToGuilds}/>
            <main className="flex-1 p-6 md:p-10 overflow-y-auto">{renderDashboardView()}</main>
        </div>
    );
}

export default App;

                    
