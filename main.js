import WhatsAppClient from './whatsapp-handler.js';
import { startServer } from './server.js';
import qrcode from 'qrcode-terminal';
import { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'; // Importar downloadMediaMessage
// import { startListening as startSlackListener, onNewMessage as onNewSlackMessage } from './slack-listener.js'; // Polling obsoleto
import fs from 'fs';
import path from 'path'; // Para construir rutas de forma segura
import { fileURLToPath } from 'url';
import { webClient, initializeSlack as initializeSlackApp } from './slack-handler.js'; // Importar el inicializador de la app Bolt
import { getMapping as getSlackChannelForWhatsAppJid, getCustomContactName } from './database-handler.js'; // Importar para leer mapeos
import MediaHandler from './media-handler.js'; // Importar MediaHandler

// Start the web server and get the socket.io instance
const io = startServer();

export const whatsappClient = new WhatsAppClient(); // Exportar la instancia

const TARGET_SENDER_JID = '573106070020@s.whatsapp.net';

let chats = new Map();

// --- Socket.IO Event Handlers ---
io.on('connection', (socket) => {
    // If not connected, show connection options to the user.
    if (!whatsappClient.isConnected) {
        socket.emit('show-connection-options');
    }

    // Send current chat list to newly connected client
    socket.emit('chatList', getChatList());

    socket.on('start-connection', async ({ usePairingCode }) => {
        logAndEmit('log', `Connection request received. Using pairing code: ${usePairingCode}`);
        whatsappClient.setUsePairingCode(usePairingCode);
        try {
            await whatsappClient.connect();
        } catch (e) {
            logAndEmit('log', `Fatal error during connection: ${e.message}`);
        }
    });

    socket.on('sendMessage', async ({ jid, text }) => {
        if (!jid || !text) return;

        try {
            await whatsappClient.sendMessage(jid, { text });
            // Also emit this to all clients to show the sent message
            io.emit('log', `> You to ${jid}: ${text}`);
        } catch (e) {
            socket.emit('log', `Error sending message: ${e.message}`);
        }
    });
});


// --- WhatsApp Client Event Handlers ---
async function handleMessage(messageData) {
    console.log('[DEBUG main.js] Entrando a handleMessage. messageData.key:', messageData.key);
    const whatsappJid = messageData.key?.remoteJid; // JID del chat (grupo o individual)
    console.log(`[DEBUG main.js] whatsappJid extraído: ${whatsappJid}`);

    if (!whatsappJid) {
        console.error(`[ERROR main.js] whatsappJid es inválido. messageData completo:`, JSON.stringify(messageData, null, 2));
        return;
    }

    // Log completo del mensaje para depuración avanzada si es necesario
    // console.log('[DEBUG main.js] handleMessage llamado con messageData:', JSON.stringify(messageData, null, 2));

    const isGroup = whatsappJid.endsWith('@g.us');
    const botJid = whatsappClient.sock?.user?.id;
    const botOwnNumber = botJid ? botJid.split('@')[0] : 'WhatsAppBot';
    const chatName = whatsappJid.endsWith('@g.us') ? `grupo ${whatsappJid}` : 'chat privado'; // Usado para UI y logs

    const currentChatJid = messageData.key.remoteJid; // JID del chat (grupo o directo)
    const participantJid = messageData.key.participant; // JID del remitente individual en un grupo, o undefined

    let idToLookupForName;
    if (participantJid) { // Mensaje de grupo, el remitente es el participante
        idToLookupForName = participantJid;
        logAndEmit('debug', `[DEBUG main.js] Mensaje de GRUPO detectado. ID para buscar nombre (participantJid): '${idToLookupForName}'`);
    } else { // Mensaje directo (o del propio bot, que se maneja después)
        idToLookupForName = currentChatJid;
        logAndEmit('debug', `[DEBUG main.js] Mensaje DIRECTO/BOT detectado. ID para buscar nombre (currentChatJid): '${idToLookupForName}'`);
    }

    let finalSenderNameToDisplay;

    // --- INICIO DE LA LÓGICA PARA DETERMINAR EL NOMBRE DEL REMITENTE ---
    if (messageData.key.fromMe) {
        finalSenderNameToDisplay = botOwnNumber; // Nombre para los mensajes del propio bot
        logAndEmit('debug', `[DEBUG main.js] Mensaje es fromMe. finalSenderNameToDisplay: '${finalSenderNameToDisplay}'`);
    } else if (idToLookupForName) {
        logAndEmit('debug', `[DEBUG main.js] Intentando obtener nombre para ID: '${idToLookupForName}'`);
        const customContactName = await getCustomContactName(idToLookupForName);
        logAndEmit('debug', `[DEBUG main.js] Resultado de getCustomContactName para '${idToLookupForName}': '${customContactName}'`);

        if (customContactName) {
            finalSenderNameToDisplay = customContactName;
        } else {
            finalSenderNameToDisplay = messageData.pushName || (idToLookupForName ? idToLookupForName.split('@')[0] : 'Desconocido');
        }
        logAndEmit('debug', `[DEBUG main.js] Mensaje NO es fromMe. finalSenderNameToDisplay después de búsqueda: '${finalSenderNameToDisplay}'`);
    } else {
        // Este caso teóricamente no debería ocurrir para mensajes entrantes que no son del bot.
        logAndEmit('warn', `[WARN main.js] idToLookupForName es falsy y el mensaje no es fromMe. Usando pushName como fallback.`);
        finalSenderNameToDisplay = messageData.pushName || 'Remitente Desconocido';
    }
    logAndEmit('debug', `[DEBUG main.js] Determinado finalSenderNameToDisplay: '${finalSenderNameToDisplay}'`);
    // --- FIN DE LA LÓGICA PARA DETERMINAR EL NOMBRE DEL REMITENTE ---

    const messageContent = messageData.message;

    // Ignorar mensajes contenedores de álbumes, ya que los elementos se manejan individualmente
    // Un mensaje es un contenedor de álbum si tiene 'albumMessage' y no otro tipo de media principal directa.
    if (messageContent && messageContent.albumMessage && MediaHandler.getWhatsAppMediaType(messageContent) === null) {
        logAndEmit('log', `[DEBUG main.js] Mensaje de tipo albumMessage (ID: ${messageData.key.id}) recibido. Ignorando el contenedor, los elementos individuales se procesarán por separado.`);
        return; // No procesar este mensaje contenedor
    }

    const mediaType = MediaHandler.getWhatsAppMediaType(messageContent);
    const caption = MediaHandler.getWhatsAppMediaCaption(messageContent);

    let baseMessageTextForSlack = '';
    if (mediaType) {
        baseMessageTextForSlack = caption || ''; // Caption o vacío
    } else {
        baseMessageTextForSlack =
            messageData.message?.conversation ||
            messageData.message?.extendedTextMessage?.text ||
            messageData.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
            messageData.message?.viewOnceMessage?.message?.extendedTextMessage?.text ||
            messageData.message?.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
            '';
    }

    // Formatear el mensaje final para Slack
    let finalSlackMessageText;
    const prefix = isGroup ? `*[${finalSenderNameToDisplay}]*:` : `*[WhatsApp]* _${finalSenderNameToDisplay}_:`;
    
    if (mediaType && baseMessageTextForSlack) {
        finalSlackMessageText = `${prefix} (${mediaType}) ${baseMessageTextForSlack}`;
    } else if (mediaType) {
        finalSlackMessageText = `${prefix} (${mediaType})`;
    } else if (baseMessageTextForSlack) {
        finalSlackMessageText = `${prefix} ${baseMessageTextForSlack}`;
    } else {
        finalSlackMessageText = `${prefix} (Mensaje vacío o tipo no soportado)`;
    }

    logAndEmit('debug', `[DEBUG main.js] Prefijo generado: '${prefix}'`);
    logAndEmit('debug', `[DEBUG main.js] Mensaje final para Slack: '${finalSlackMessageText}'`);

    // --- Lógica para enviar a Slack ---
    try {
        const mapping = await getSlackChannelForWhatsAppJid(whatsappJid);

        if (mapping && mapping.slackChannelId) {
            const actualSlackChannelId = mapping.slackChannelId;
            logAndEmit('log', `Intentando reenviar mensaje de WA (${whatsappJid}) a Slack (${actualSlackChannelId})`);

            if (mediaType) {
                try {
                    // La función downloadCallback que espera processWhatsAppMedia toma el objeto de mensaje específico (ej: imageMessage)
                    const downloadFunction = async (msgToDownload) => { // msgToDownload es messageData (proto.IWebMessageInfo)
                        const mContent = msgToDownload.message;
                        let determinedMediaTypeForDebug = null;
                        if (mContent) {
                            // Lógica simplificada para obtener mediaType solo para depuración, similar a getContentType de Baileys
                            determinedMediaTypeForDebug = Object.keys(mContent).find(key => 
                                key.endsWith('Message') && 
                                ![ 'senderKeyDistributionMessage', 
                                    'protocolMessage', 
                                    'deviceSentMessage',
                                    'editedMessage',
                                    // Añadir otros tipos de mensajes no multimedia si aparecen en logs
                                ].includes(key)
                            );
                            console.log('[DEBUG main.js downloadFunction] msgToDownload.key.id:', msgToDownload.key.id);
                            // console.log('[DEBUG main.js downloadFunction] mContent:', JSON.stringify(mContent, null, 2)); // Puede ser muy verboso
                            console.log('[DEBUG main.js downloadFunction] Determined mediaType for debug:', determinedMediaTypeForDebug);
                            if (determinedMediaTypeForDebug && mContent[determinedMediaTypeForDebug]) {
                                console.log(`[DEBUG main.js downloadFunction] mContent[${determinedMediaTypeForDebug}] exists.`);
                            } else if (determinedMediaTypeForDebug) {
                                console.error(`[FATAL DEBUG main.js downloadFunction] mContent[${determinedMediaTypeForDebug}] IS FALSY OR UNDEFINED!`);
                            } else {
                                console.warn('[DEBUG main.js downloadFunction] Could not determine mediaType for debug.');
                            }
                        }

                        return await downloadMediaMessage(
                            msgToDownload, 
                            'buffer',
                            {},
                            { // Restaurar ctx
                                logger: console,
                                reuploadRequest: whatsappClient.sock.updateMediaMessage
                            }
                        );
                    };
                    
                    // messageData contiene el mensaje completo, processWhatsAppMedia extraerá el mediaObj correcto
                    const mediaFileData = await MediaHandler.processWhatsAppMedia(messageData, downloadFunction);

                    if (mediaFileData && mediaFileData.buffer) {
                        await webClient.files.uploadV2({
                            channel_id: actualSlackChannelId,
                            initial_comment: finalSlackMessageText, // Usar el texto ya formateado
                            file: mediaFileData.buffer,
                            filename: mediaFileData.name,
                        });
                        logAndEmit('log', `Archivo multimedia de WA (${whatsappJid}) reenviado a Slack (${slackChannelId}) como ${mediaFileData.name}`);
                    } else {
                        console.warn('[WARN main.js] No se pudo procesar el archivo multimedia de WhatsApp. Enviando solo texto.');
                        await webClient.chat.postMessage({
                            channel: actualSlackChannelId,
                            text: finalSlackMessageText,
                            parse: 'mrkdwn'
                        });
                    }
                } catch (mediaError) {
                    console.error('[ERROR main.js] Error procesando o enviando archivo multimedia a Slack:', mediaError);
                    logAndEmit('log', `Error al enviar archivo multimedia a Slack: ${mediaError.message}. Enviando solo texto.`);
                    await webClient.chat.postMessage({
                        channel: actualSlackChannelId,
                        text: finalSlackMessageText, // Fallback a enviar solo el texto formateado
                        parse: 'mrkdwn'
                    });
                }
            } else {
                // Mensaje de texto simple (sin adjunto multimedia)
                await webClient.chat.postMessage({
                    channel: actualSlackChannelId,
                    text: finalSlackMessageText,
                    parse: 'mrkdwn'
                });
                logAndEmit('log', `Mensaje de texto de WA (${whatsappJid}) reenviado a Slack (${actualSlackChannelId})`);
            }
        } else {
            const isGroup = whatsappJid.endsWith('@g.us');
            let logMessage = '';

            if (isGroup) {
                try {
                    const groupMeta = await whatsappClient.sock.groupMetadata(whatsappJid);
                    const groupName = groupMeta.subject;
                    logMessage = `[INFO] Mensaje recibido del grupo '${groupName}' (${whatsappJid}) sin mapeo de Slack.`;
                } catch (e) {
                    logMessage = `[INFO] Mensaje recibido del grupo con ID ${whatsappJid} sin mapeo de Slack. No se pudo obtener el nombre.`;
                }
            } else {
                const personName = messageData.pushName || 'desconocido';
                logMessage = `[INFO] Mensaje recibido de '${personName}' (${whatsappJid}) sin mapeo de Slack.`;
            }
            logAndEmit('log', logMessage);
        }
    } catch (error) {
        console.error('[ERROR main.js] Error en bloque de reenvío a Slack:', error.message, error.stack);
        logAndEmit('log', `Error general al procesar mensaje de WhatsApp para Slack: ${error.message}`);
    }

    // --- Actualizar UI y logs locales ---
    const uiMessageText = mediaType ? `(${mediaType}) ${baseMessageTextForSlack || ''}`.trim() : baseMessageTextForSlack;
    
    // Determinar el nombre del chat para la lista de la UI
    let chatDisplayNameForUiList;
    if (isGroup) {
        chatDisplayNameForUiList = chatName; // Mantiene "grupo JID_GRUPO"
    } else {
        // Para DMs, usar el nombre del contacto (personalizado o pushName)
        chatDisplayNameForUiList = finalSenderNameToDisplay;
    }

    if (!chats.has(whatsappJid)) {
        chats.set(whatsappJid, { name: chatDisplayNameForUiList, jid: whatsappJid, messages: [] });
    }
    // Usar finalSenderNameToDisplay para el remitente del mensaje individual en la UI
    chats.get(whatsappJid).messages.push({ sender: finalSenderNameToDisplay, text: uiMessageText });

    updateChatList(); // Actualiza la lista de chats en la UI

    // Usar finalSenderNameToDisplay para el nombre que se muestra en los logs de la UI y en 'newMessage'
    // Para grupos, displayNameForEmit será "NombreRemitente en grupo JIDGrupo"
    // Para DMs, displayNameForEmit será "NombreRemitente"
    const displayNameForEmit = isGroup ? `${finalSenderNameToDisplay} en ${chatName}` : finalSenderNameToDisplay;
    io.emit('log', `${displayNameForEmit}: ${uiMessageText}`);
    io.emit('newMessage', { 
        jid: whatsappJid, 
        senderName: finalSenderNameToDisplay, // Nombre del remitente del mensaje
        text: uiMessageText, 
        displayName: displayNameForEmit // Nombre formateado para mostrar en la UI (log/notificación)
    });
}

function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, pairingCode } = update;

    if (qr) {
        logAndEmit('log', 'QR code received. Scan with your phone.');
        qrcode.generate(qr, { small: true }, (qrString) => {
            io.emit('qr', qrString);
        });
    }

    if (pairingCode) {
        const codeMessage = `Your pairing code is: ${pairingCode}`;
        logAndEmit('log', codeMessage);
        io.emit('qr', `Your pairing code is:\n\n${pairingCode}`); // Also show in the QR box
    }

    logAndEmit('status', `Connection status: ${connection || 'unknown'}`);

    if (connection === 'open') {
        logAndEmit('status', 'WhatsApp client connected');
        io.emit('qr', ''); // Clear QR/pairing code
    } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        logAndEmit('status', `Connection closed. Reason: ${reason}.`);
        // If logged out, we need to ask the user to connect again.
        if (reason === DisconnectReason.loggedOut) {
            logAndEmit('status', 'Logged out. Please select a method to log in again.');
            io.emit('show-connection-options');
        }
    }
}

function getChatList() {
    return Array.from(chats.values()).map(chat => ({ name: chat.name, jid: chat.jid }));
}

function updateChatList() {
    io.emit('chatList', getChatList());
}

// --- Utility Functions ---
function logAndEmit(event, message) {
    console.log(message);
    io.emit(event, message);
}

// --- Main Logic ---
async function main() {
    whatsappClient.onMessage(handleMessage);
    whatsappClient.onConnectionUpdate(handleConnectionUpdate);

    // Inicializar y arrancar la app de Slack (Bolt)
    initializeSlackApp(whatsappClient); // Pasar la instancia de whatsappClient
    // La app de Bolt se inicia automáticamente dentro de slack-handler.js con app.start()
    // ya no se necesita startSlackListener ni onNewSlackMessage aquí para el polling.
    console.log('[INFO MAIN] Slack (Bolt) event listener inicializado desde slack-handler.js.');

    logAndEmit('log', 'Attempting to connect to WhatsApp automatically (QR code method)...');
    whatsappClient.setUsePairingCode(false); // Usar QR por defecto para esta prueba automática
    try {
        await whatsappClient.connect();
    } catch (e) {
        logAndEmit('log', `Error during automatic WhatsApp connection: ${e.message}`);
    }

    logAndEmit('log', 'Server started. Slack listener active. WhatsApp connection attempted.');

    // Intervalo para mantener el proceso activo (diagnóstico)
    setInterval(() => {
        // Este callback puede estar vacío o realizar alguna tarea de mantenimiento ligera si es necesario
        // console.log('[DEBUG] main.js keep-alive interval tick');
    }, 1000 * 60 * 5); // Por ejemplo, cada 5 minutos
}


process.on('SIGINT', () => {
    io.emit('log', 'Shutting down...');
    // whatsappClient.close().finally(() => process.exit(0)); // Comentado para persistir sesión
    process.exit(0);
});

main();
