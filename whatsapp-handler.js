import Baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { whatsappPhoneNumber } from './config.js'; // Asumiendo que config.js es un módulo o se resolverá
import qrcode from 'qrcode-terminal';
import { read as readDb, getRecentChats, updateRecentChats } from './database-handler.js';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` });
logger.level = 'silent';

const msgRetryCounterCache = new NodeCache();

class WhatsAppClient {
    constructor() {
        this.sock = null;
        this.connectionState = 'close'; // 'connecting', 'open', 'close'
        this.onMessageCallback = null;
        this.onConnectionUpdateCallback = null;
        this.usePairingCode = false;
        this.promptHandler = null; // Para manejar prompts desde la UI
    }

    onMessage(callback) {
        this.onMessageCallback = callback;
    }

    onConnectionUpdate(callback) {
        this.onConnectionUpdateCallback = callback;
    }

    setUsePairingCode(usePairing) {
        this.usePairingCode = !!usePairing;
    }

    setPromptHandler(handler) {
        this.promptHandler = handler;
    }

    async connect() {
        // this.usePairingCode (propiedad de la clase) determinará el método. No se necesita variable local aquí.

        // Comentamos este bloque para que la sesión de WhatsApp persista
        /*
        const authDir = path.join(__dirname, 'baileys_auth_info');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('Carpeta de sesión de WhatsApp eliminada para forzar una nueva conexión.');
        }
        */

        const { state, saveCreds } = await Baileys.useMultiFileAuthState('baileys_auth_info');
        const { version, isLatest } = await Baileys.fetchLatestBaileysVersion();
        console.log(`Usando WhatsApp Web v${version.join('.')}, ¿es la última versión?: ${isLatest}`);

        this.sock = Baileys.default({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: Baileys.makeCacheableSignalKeyStore(state.keys, logger),
            },
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => jid?.endsWith('@broadcast'),
        });

        // REGISTRAR EVENTOS PRIMERO para no perder el QR inicial
        this.sock.ev.process(async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update'];
                const { connection, lastDisconnect, qr } = update;

                if (qr && !this.usePairingCode) { // Usar this.usePairingCode
                    console.log('Escanea este código QR con tu WhatsApp:');
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    this.connectionState = 'close'; // ACTUALIZAR connectionState
                    console.log('[DEBUG] Actualizando estado de conexión a:', this.connectionState);
                    
                    const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500;
                    const shouldReconnect = statusCode !== Baileys.DisconnectReason.loggedOut;
                    const reason = lastDisconnect.error?.data?.message || lastDisconnect.error?.message || 'Desconocida';
                    const notification = `🔴 Conexión de WhatsApp cerrada. Razón: ${reason}. ${shouldReconnect ? 'Intentando reconectar...' : 'Se requiere intervención manual.'}`;
                    console.error(notification);

                    if (this.onConnectionUpdateCallback) {
                        this.onConnectionUpdateCallback({ connection: 'close', reason });
                    }

                    if (shouldReconnect) {
                        console.log('Intentando reconectar...');
                        this.connect();
                    } else {
                        console.log('Desconexión permanente. No se reconectará.');
                    }
                } else if (connection === 'open') {
                    this.connectionState = 'open'; // ACTUALIZAR connectionState
                    console.log('[DEBUG] Actualizando estado de conexión a:', this.connectionState);
                    
                    const notification = '🟢 Conexión con WhatsApp establecida exitosamente.';
                    console.log(notification);
                    if (this.onConnectionUpdateCallback) {
                        this.onConnectionUpdateCallback({ connection: 'open' });
                    }
                }
            }

            if (events['creds.update']) {
                await saveCreds();
            }

            if (events['messages.upsert']) {
                const upsert = events['messages.upsert'];
                if (upsert.type === 'notify' && this.onMessageCallback) {
                    for (const msg of upsert.messages) {
                        if (!msg.key.fromMe && msg.message) { // Ignorar mensajes propios y asegurar que haya contenido de mensaje
                            console.log('[DEBUG whatsapp-handler] Mensaje recibido:', JSON.stringify(msg, null, 2));
                            
                            // Registrar chat reciente
                            try {
                                await readDb(); // Asegurar que los datos de la DB estén cargados
                                const chatId = msg.key.remoteJid;
                                let chatName = msg.pushName; // Nombre del contacto para chats individuales
                                if (Baileys.isJidGroup(chatId)) {
                                    try {
                                        const groupMeta = await this.sock.groupMetadata(chatId);
                                        chatName = groupMeta.subject;
                                    } catch (groupError) {
                                        console.warn(`[WARN WHATSAPP] No se pudo obtener metadata para el grupo ${chatId}:`, groupError.message);
                                        chatName = chatName || `Grupo ${chatId.substring(0, 5)}`; // Fallback si pushName no está o es un grupo sin nombre conocido
                                    }
                                } else if (!chatName) {
                                   // Si no es grupo y no hay pushName (ej. mensaje de sistema o broadcast no ignorado)
                                   chatName = `Chat ${chatId.substring(0,5)}...`;
                                }

                                const timestamp = new Date().toISOString();
                                let recentChats = getRecentChats();

                                const existingChatIndex = recentChats.findIndex(c => c.id === chatId);
                                if (existingChatIndex > -1) {
                                    recentChats[existingChatIndex].name = chatName;
                                    recentChats[existingChatIndex].lastSeen = timestamp;
                                } else {
                                    recentChats.push({ id: chatId, name: chatName, lastSeen: timestamp });
                                }

                                recentChats.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
                                const MAX_RECENT_CHATS = 50;
                                if (recentChats.length > MAX_RECENT_CHATS) {
                                    recentChats = recentChats.slice(0, MAX_RECENT_CHATS);
                                }
                                await updateRecentChats(recentChats);
                                console.log(`[INFO WHATSAPP] Chat ${chatName} (ID: ${chatId}) actualizado/añadido a recientes.`);
                            } catch (dbError) {
                                console.error('[ERROR WHATSAPP] Error actualizando chats recientes en DB:', dbError);
                            }

                            if (this.onMessageCallback) {
                               this.onMessageCallback(msg);
                            }
                        }
                    }
                }
            }
        });

        if (!this.sock.authState.creds.registered) {
            if (this.usePairingCode === true) { // Conectar usando código de emparejamiento (preestablecido)
                console.log('[INFO] whatsapp-handler: Intentando conectar con CÓDIGO DE EMPAREJAMIENTO (método preestablecido).');
                if (!whatsappPhoneNumber) {
                    console.error('[ERROR] whatsapp-handler: El número de teléfono de WhatsApp (whatsappPhoneNumber) no está configurado en config.js, necesario para el código de emparejamiento.');
                    if (this.onConnectionUpdateCallback) {
                        this.onConnectionUpdateCallback({ connection: 'close', error: new Error('whatsappPhoneNumber no configurado para pairing code') });
                    }
                    return; // Salir si no hay número para el pairing code
                }
                const phoneNumber = whatsappPhoneNumber.replace(/[^0-9]/g, '');
                console.log('[INFO] whatsapp-handler: Solicitando código de emparejamiento para el número:', phoneNumber);
                try {
                    const code = await this.sock.requestPairingCode(phoneNumber);
                    console.log(`[INFO] whatsapp-handler: Tu código de emparejamiento es: ${code}`);
                    if (this.onConnectionUpdateCallback) {
                        this.onConnectionUpdateCallback({ pairingCode: code, connection: 'connecting' });
                    }
                } catch (e) {
                    console.error('[ERROR] whatsapp-handler: Error solicitando código de emparejamiento:', e);
                    if (this.onConnectionUpdateCallback) {
                        this.onConnectionUpdateCallback({ connection: 'close', error: e });
                    }
                }
            } else { // Conectar usando código QR (preestablecido o por defecto, this.usePairingCode es false)
                console.log('[INFO] whatsapp-handler: Intentando conectar con CÓDIGO QR (método preestablecido o por defecto).');
                // El código QR será manejado por el evento 'connection.update' si es una nueva sesión.
                // Si hay un QR, el evento 'connection.update' lo emitirá.
            }
        }
        // Ya no se necesita readline aquí si no vamos a preguntar interactivamente.

        return this.sock;
    }

    async sendMessage(to, message, options = {}) {
        if (this.isConnected) {
            try {
                return await this.sock.sendMessage(to, message, options);
            } catch (error) {
                logger.error({error, to, message}, "Error enviando mensaje");
                throw error;
            }
        } else {
            throw new Error("Cliente de WhatsApp no conectado.");
        }
    }
    
    async downloadMedia(message) {
        return await Baileys.downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: this.sock.updateMediaMessage });
    }

    get isConnected() {
        return this.sock && this.connectionState === 'open';
    }

    async close() {
        if (this.sock) {
            await this.sock.logout();
        }
    }
}

export default WhatsAppClient;
