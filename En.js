// --- IMPORTACIONES g---
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const cors = require('cors');
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// --- CONFIGURACIÓN DE EXPRESS Y SEGURIDAD ---
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
	max: 100, // Limita cada IP a 100 peticiones por ventana de tiempo
	standardHeaders: true,
	legacyHeaders: false,
    message: { message: 'Demasiadas peticiones desde esta IP, por favor intenta de nuevo en 15 minutos.' }
});
app.use('/api/', apiLimiter);

// --- INICIALIZACIÓN DE SERVICIOS ---
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('ready', () => console.log(`Bot conectado como ${client.user.tag}!`));
const userAccessTokens = new Map();

// --- MIDDLEWARES DE SEGURIDAD ---
const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).send({ message: 'No autorizado.' });
    try {
        req.user = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        next();
    } catch (error) { return res.status(401).send({ message: 'Token de Firebase inválido o expirado.' }); }
};

const checkGuildAdmin = async (req, res, next) => {
    const uid = req.user.uid;
    const guildId = req.params.guildId || req.body.guildId;
    if (!guildId) return res.status(400).send({ message: 'No se especificó un ID de servidor.' });
    try {
        const userPermsDoc = await db.collection('users').doc(uid).collection('private').doc('permissions').get();
        if (!userPermsDoc.exists || !userPermsDoc.data().adminGuilds?.includes(guildId)) {
            return res.status(403).send({ message: 'No tienes permisos de administrador en este servidor.' });
        }
        next();
    } catch (error) { return res.status(500).send({ message: 'No se pudieron verificar los permisos.' }); }
};

// --- ENDPOINTS DE AUTENTICACIÓN ---
app.get('/auth/login', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20email%20guilds`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/callback', async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) { console.error(`Error en callback de Discord: ${error_description}`); return res.redirect(`${process.env.FRONTEND_URL}/login?error=${encodeURIComponent(error_description)}`); }
    if (!code) { return res.redirect(`${process.env.FRONTEND_URL}/login?error=No_se_recibio_codigo`); }
    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI, }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const { access_token } = tokenResponse.data;
        const userResponse = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
        const { id: uid, username, avatar } = userResponse.data;
        userAccessTokens.set(uid, access_token);
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${access_token}` } });
        const adminGuildIds = userGuildsResponse.data.filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.Administrator)).map(g => g.id);
        await db.collection('users').doc(uid).collection('private').doc('permissions').set({ adminGuilds: adminGuildIds }, { merge: true });
        await admin.auth().updateUser(uid, { displayName: username, photoURL: `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png` }).catch(err => { if (err.code === 'auth/user-not-found') return admin.auth().createUser({ uid, displayName: username, photoURL: `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png` }); throw err; });
        const firebaseToken = await admin.auth().createCustomToken(uid);
        res.redirect(`${process.env.FRONTEND_URL}/login?token=${firebaseToken}`);
    } catch (error) {
        console.error('Error crítico en el flujo de autenticación:', error.response?.data || error.message);
        res.redirect(`${process.env.FRONTEND_URL}/login?error=Fallo_critico_del_servidor`);
    }
});

// --- ENDPOINTS DE LA API ---
const snowflakeRegex = /^\d{17,19}$/;

app.get('/api/guilds', verifyFirebaseToken, async (req, res) => {
    const uid = req.user.uid;
    const accessToken = userAccessTokens.get(uid);
    if (!accessToken) return res.status(401).json({ message: 'Token de Discord expirado. Por favor, re-inicia sesión.' });

    try {
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${accessToken}` } });
        console.log(`[DEBUG] Obtenidos ${userGuildsResponse.data.length} servidores de la API de Discord para el usuario ${uid}`);

        const botGuilds = client.guilds.cache;
        
        const guildsDataPromises = userGuildsResponse.data.map(async guild => {
            const isAdmin = new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.Administrator);
            const settingsDoc = await db.collection('guilds').doc(guild.id).get();
            return {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                isAdmin,
                isBotMember: botGuilds.has(guild.id),
                isPremium: settingsDoc.exists ? settingsDoc.data().isPremium || false : false,
            };
        });
        
        const finalGuilds = await Promise.all(guildsDataPromises);
        console.log(`[DEBUG] Enviando ${finalGuilds.length} servidores al frontend.`);
        res.json(finalGuilds);

    } catch (error) {
        console.error('Guilds Error:', error.response?.data || error.message);
        userAccessTokens.delete(uid);
        res.status(401).json({ message: 'El token de Discord ha expirado.' });
    }
});


app.post('/api/guilds/:guildId/applications', verifyFirebaseToken, async (req, res) => {
    const { guildId } = req.params;
    const { submission } = req.body;
    if (!submission) return res.status(400).send({ message: 'Faltan datos de la postulación.' });
    try {
        const dataToSave = { ...submission, date: admin.firestore.FieldValue.serverTimestamp(), status: 'Pending' };
        await db.collection('guilds').doc(guildId).collection('applications').add(dataToSave);
        const formDoc = await db.collection('guilds').doc(guildId).collection('forms').doc(submission.formId).get();
        if (formDoc.exists) {
            const formData = formDoc.data();
            if (formData.notificationChannelId && snowflakeRegex.test(formData.notificationChannelId)) {
                const template = formData.webhookTemplate || `Enviada por **{userName}**.`;
                const description = template.replace(/{userName}/g, submission.userName).replace(/{formTitle}/g, submission.formTitle);
                const embed = new EmbedBuilder().setTitle(`Nueva Postulación Recibida: ${submission.formTitle}`).setDescription(description).setColor(0x5865F2).setTimestamp().setAuthor({name: submission.userName, iconURL: submission.userAvatar});
                try {
                    const channel = await client.channels.fetch(formData.notificationChannelId);
                    if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
                } catch (webhookError) { console.error("Webhook Error (ignorado):", webhookError.message); }
            }
        }
        res.status(201).send({ message: 'Postulación recibida.' });
    } catch (error) { console.error("Submit App Error:", error); res.status(500).send({ message: "Error al guardar la postulación." }); }
});

app.put('/api/guilds/:guildId/applications/:appId', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, appId } = req.params;
    const { status } = req.body;
    if (!status || !['Accepted', 'Rejected'].includes(status)) return res.status(400).send({ message: 'Estado inválido.' });
    const dataToUpdate = { status, reviewedBy_id: req.user.uid, reviewedBy_name: req.user.name, reviewedAt: new Date() };
    try { await db.collection('guilds').doc(guildId).collection('applications').doc(appId).update(dataToUpdate); res.status(200).send({ message: 'Decisión guardada.' }); }
    catch (error) { console.error(error); res.status(500).send({ message: 'Error al guardar la decisión.' }); }
});

app.post('/api/guilds/:guildId/forms', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { form } = req.body;
    const docData = { ...form, createdBy_id: req.user.uid, createdBy_name: req.user.name, createdAt: admin.firestore.FieldValue.serverTimestamp() };
    try { const docRef = await db.collection('guilds').doc(guildId).collection('forms').add(docData); res.status(201).send({ id: docRef.id }); }
    catch (error) { console.error(error); res.status(500).send({ message: 'Error al crear el formulario.' }); }
});

app.put('/api/guilds/:guildId/forms/:formId', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, formId } = req.params;
    const { form } = req.body;
    try { await db.collection('guilds').doc(guildId).collection('forms').doc(formId).set(form, { merge: true }); res.status(200).send({ message: 'Formulario actualizado.' }); }
    catch (error) { console.error(error); res.status(500).send({ message: 'Error al actualizar el formulario.' }); }
});

app.delete('/api/guilds/:guildId/forms/:formId', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, formId } = req.params;
    try { await db.collection('guilds').doc(guildId).collection('forms').doc(formId).delete(); res.status(200).send({ message: 'Formulario eliminado.' }); }
    catch (error) { console.error(error); res.status(500).send({ message: 'Error al eliminar el formulario.' }); }
});

app.get('/api/guilds/:guildId/validate-role/:roleId', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, roleId } = req.params;
    if (!snowflakeRegex.test(roleId)) return res.status(400).json({ isValid: false, message: 'ID inválido.' });
    try { const guild = await client.guilds.fetch(guildId); const role = await guild.roles.fetch(roleId); res.status(200).json({ isValid: !!role, message: role ? `Rol válido: ${role.name}` : 'El rol no existe.' }); }
    catch (error) { res.status(200).json({ isValid: false, message: 'El rol no existe en este servidor.' }); }
});

app.post('/api/assign-roles', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, memberId, roles } = req.body;
    if (!guildId || !memberId || !Array.isArray(roles) || roles.length === 0) return res.status(400).send({ message: 'Faltan datos.' });
    try { const guild = await client.guilds.fetch(guildId); const member = await guild.members.fetch(memberId); await member.roles.add(roles.filter(r => r)); res.status(200).send({ message: `Roles asignados.` }); }
    catch (error) { console.error("Assign Role Error:", error); res.status(500).send({ message: "No se pudieron asignar los roles." }); }
});

app.post('/api/remove-roles', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, memberId, roles } = req.body;
    if (!guildId || !memberId || !Array.isArray(roles) || roles.length === 0) return res.status(400).send({ message: 'Faltan datos.' });
    try { const guild = await client.guilds.fetch(guildId); const member = await guild.members.fetch(memberId); await member.roles.remove(roles.filter(r => r)); res.status(200).send({ message: `Roles eliminados.` }); }
    catch (error) { console.error("Remove Role Error:", error); res.status(500).send({ message: "No se pudieron quitar los roles." }); }
});

app.post('/api/notify-user', verifyFirebaseToken, async (req, res) => {
    const { memberId, message } = req.body;
    if (!snowflakeRegex.test(memberId) || !message) return res.status(400).send({ message: 'Faltan datos o son inválidos.' });
    try { const user = await client.users.fetch(memberId); await user.send(message); res.status(200).send({ message: `Mensaje enviado a ${user.tag}` }); }
    catch (error) { console.error("DM Error:", error); res.status(500).send({ message: "No se pudo enviar el DM." }); }
});

app.post('/api/set-premium', verifyFirebaseToken, checkGuildAdmin, async (req, res) => {
    const { guildId, isPremium } = req.body;
    if (!snowflakeRegex.test(guildId) || typeof isPremium !== 'boolean') return res.status(400).send({ message: 'Datos inválidos.' });
    try { await db.collection('guilds').doc(guildId).set({ isPremium }, { merge: true }); res.status(200).send({ message: `Estado premium actualizado.` }); }
    catch (error) { console.error("Premium Error:", error); res.status(500).send({ message: 'Error al actualizar el estado premium.' }); }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Backend escuchando en ${PORT}`);
  client.login(process.env.DISCORD_BOT_TOKEN);
});

