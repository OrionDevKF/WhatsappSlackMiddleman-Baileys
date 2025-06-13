import boltPkg from '@slack/bolt';
const { App, LogLevel } = boltPkg;
import webApiPkg from '@slack/web-api';
const { WebClient, LogLevel: WebClientLogLevel } = webApiPkg;
import axios from 'axios';
import * as config from './config.js'; // Import config as ES Module
import * as db from './database-handler.js'; // db object from database-handler.js
import { addContact, getAllContacts, editContact } from './database-handler.js'; // Importar funciones para contactos
import MediaHandler from './media-handler.js';
import fs from 'fs';
import path from 'path';

const slackConfig = config.slack;

// Global variable to store chats for /createchannel
let lastDisplayedUnmappedChats = [];

const processedMessageTimestamps = new Set();
const processedCommandTriggerIds = new Set();
const MESSAGE_TS_TTL = 10 * 60 * 1000; // 10 minutos en milisegundos

if (!slackConfig.token || !slackConfig.signingSecret || !slackConfig.appToken) {
    console.error('ERROR: Faltan tokens de Slack. Verifica tu archivo config.js');
    console.error('Necesitas: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET y SLACK_APP_TOKEN');
}

const webClient = new WebClient(slackConfig.token, {
    logLevel: WebClientLogLevel.INFO
});

const app = new App({
    token: slackConfig.token,
    signingSecret: slackConfig.signingSecret,
    socketMode: true,
    appToken: slackConfig.appToken,
    logLevel: LogLevel.INFO
});

async function downloadFile(url) {
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${slackConfig.token}` },
        responseType: 'arraybuffer'
    });
    return response.data;
}

// Actualizada para la nueva estructura de mapeo
async function getWhatsAppJidForSlackChannel(slackChannelId) {
    await db.read();
    const allMappings = db.getAllMappings(); // Esto es groupMappings
    return Object.keys(allMappings).find(waId => allMappings[waId] && allMappings[waId].slackChannelId === slackChannelId);
}

// Función para sanitizar nombres de canal de Slack
function sanitizeChannelName(name) {
    let sanitized = name.toLowerCase()
        .replace(/\s+/g, '-') // Reemplazar espacios con guiones
        .replace(/[^a-z0-9-]/g, ''); // Eliminar caracteres no permitidos

    // Truncar si es muy largo (Slack puede truncar a 21 caracteres para nombres de canal)
    if (sanitized.length > 21) {
        // Dejar espacio para sufijos como -1, -2
        const baseMaxLength = 21 - 2; // ej. 19
        sanitized = sanitized.substring(0, baseMaxLength);
    }
    // Asegurar que no esté vacío después de sanitizar
    if (!sanitized) {
        sanitized = `chat-${new Date().getTime().toString().slice(-5)}`;
    }
    return sanitized;
}

// Manejador para el comando /view
async function handleViewCommand({ ack, say, client }) {
    await ack();
    try {
        await db.read();
        const allMappings = db.getAllMappings(); // groupMappings
        const recentChats = db.getRecentChats(); // recentWhatsappChats

        const mappedWhatsappChatIds = Object.keys(allMappings);
        
        const unmappedChats = recentChats
            .filter(chat => !mappedWhatsappChatIds.includes(chat.id))
            .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

        if (unmappedChats.length === 0) {
            await say("No hay chats recientes de WhatsApp sin asignar.");
            lastDisplayedUnmappedChats = [];
            return;
        }

        lastDisplayedUnmappedChats = unmappedChats.slice(0, 5);

        let messageText = "Chats recientes de WhatsApp sin asignar (los 5 más nuevos):\n";
        lastDisplayedUnmappedChats.forEach((chat, index) => {
            // Mostrar solo la parte numérica del ID de WhatsApp para brevedad si es un JID completo
            const displayId = chat.id.includes('@') ? chat.id.split('@')[0] : chat.id;
            messageText += `${index}. ${chat.name || `Chat ${displayId}`} (ID: ${displayId}, Visto: ${new Date(chat.lastSeen).toLocaleString()})\n`;
        });
        messageText += "\nPara crear y enlazar un canal, usa `/createchannel [número]` (ej: `/createchannel 0`).";
        
        await say(messageText);

    } catch (error) {
        console.error("Error en comando /view:", error);
        await say("Hubo un error al procesar tu solicitud para /view.");
    }
}

// Manejador para el comando /createchannel
async function handleCreateChannelCommand({ command, ack, say, client }) {
    await ack();
    const args = command.text.trim();
    const chatIndex = parseInt(args, 10);

    if (isNaN(chatIndex) || chatIndex < 0 || chatIndex >= lastDisplayedUnmappedChats.length) {
        await say(`Índice inválido. Por favor, usa un número entre 0 y ${lastDisplayedUnmappedChats.length - 1} basado en la última lista de \`/view\`.`);
        return;
    }

    const selectedWhatsappChat = lastDisplayedUnmappedChats[chatIndex];
    if (!selectedWhatsappChat || !selectedWhatsappChat.id) {
        await say("Error: No se pudo encontrar el chat de WhatsApp seleccionado. Intenta ejecutar \`/view\` de nuevo.");
        return;
    }
    
    const whatsappChatId = selectedWhatsappChat.id;
    const whatsappChatName = selectedWhatsappChat.name || `Chat ${whatsappChatId.split('@')[0]}`;

    try {
        await db.read();
        const existingMapping = db.getMapping(whatsappChatId);

        if (existingMapping && existingMapping.slackChannelId) {
            await say(`Este chat de WhatsApp (ID: ${whatsappChatId.split('@')[0]}) ya está mapeado al canal de Slack <#${existingMapping.slackChannelId}>.`);
            return;
        }

        let baseChannelName = sanitizeChannelName(whatsappChatName);
        let finalChannelName = baseChannelName;
        let channelCreated = false;
        let newChannelInfo;
        let attempt = 0;

        while (!channelCreated && attempt < 5) {
            try {
                const result = await client.conversations.create({
                    name: finalChannelName,
                    is_private: false
                });
                if (result.ok && result.channel && result.channel.id) {
                    newChannelInfo = result.channel;
                    channelCreated = true;
                } else {
                    throw new Error(result.error || "Error desconocido al crear canal.");
                }
            } catch (error) {
                if (error.data && error.data.error === 'name_taken') {
                    attempt++;
                    // Asegurar que el nombre base + sufijo no exceda el límite
                    const suffix = `-${attempt}`;
                    const maxBaseLength = 21 - suffix.length;
                    finalChannelName = `${baseChannelName.substring(0, maxBaseLength)}${suffix}`;
                    console.log(`Nombre de canal ${finalChannelName} tomado, intentando con ${finalChannelName}...`);
                } else if (error.data && error.data.error === 'restricted_action') {
                     await say("Error: El bot no tiene permiso para crear canales públicos. Por favor, revisa los permisos del bot en Slack.");
                     console.error("Error al crear canal:", error.data);
                     return;
                } else {
                    console.error("Error al crear canal de Slack:", error);
                    await say(`Hubo un error al crear el canal de Slack: ${error.message || (error.data && error.data.error) || 'Error desconocido'}`);
                    return;
                }
            }
        }

        if (!channelCreated || !newChannelInfo) {
            await say("No se pudo crear el canal de Slack después de varios intentos. Por favor, inténtalo de nuevo más tarde o crea el canal manualmente.");
            return;
        }
        
        const newSlackChannelId = newChannelInfo.id;
        const newSlackChannelName = newChannelInfo.name;

        const mappingDetails = {
            slackChannelId: newSlackChannelId,
            slackChannelName: newSlackChannelName,
            whatsappChatName: whatsappChatName 
        };
        await db.addMapping(whatsappChatId, mappingDetails);
        
        try {
            await client.conversations.join({ channel: newSlackChannelId });
        } catch (joinError) {
            console.warn(`No se pudo unir el bot al canal ${newSlackChannelName}:`, joinError.data ? joinError.data.error : joinError.message);
        }

        // Invitar al @admin-team si está configurado
        if (slackConfig.adminTeamUserGroupId) {
            try {
                console.log(`[INFO] Intentando invitar al grupo de administradores (ID: ${slackConfig.adminTeamUserGroupId}) al canal ${newSlackChannelName} (${newSlackChannelId}).`);
                const usergroupMembers = await client.usergroups.users.list({
                    usergroup: slackConfig.adminTeamUserGroupId
                });

                if (usergroupMembers.ok && usergroupMembers.users && usergroupMembers.users.length > 0) {
                    const userIdsToInvite = usergroupMembers.users;
                    // Slack API espera los IDs de usuario como una cadena separada por comas
                    const inviteResult = await client.conversations.invite({
                        channel: newSlackChannelId,
                        users: userIdsToInvite.join(',')
                    });

                    if (inviteResult.ok) {
                        console.log(`[INFO] Grupo @admin-team (o sus miembros) invitados exitosamente a <#${newSlackChannelId}>.`);
                        // Opcional: notificar en el canal o al usuario que ejecutó el comando
                        // await say(`El grupo @admin-team ha sido invitado a <#${newSlackChannelId}>.`);
                    } else {
                        console.error(`[ERROR] No se pudo invitar al grupo @admin-team a <#${newSlackChannelId}>:`, inviteResult.error);
                        // Podrías querer notificar al usuario sobre este fallo específico
                        // await say(`Advertencia: No se pudo invitar automáticamente al @admin-team al canal: ${inviteResult.error}`);
                    }
                } else if (usergroupMembers.users && usergroupMembers.users.length === 0) {
                    console.warn(`[WARN] El grupo de usuarios @admin-team (ID: ${slackConfig.adminTeamUserGroupId}) no tiene miembros.`);
                } else {
                    console.error(`[ERROR] No se pudieron obtener los miembros del grupo @admin-team (ID: ${slackConfig.adminTeamUserGroupId}):`, usergroupMembers.error);
                }
            } catch (error) {
                console.error(`[ERROR] Fallo al intentar invitar al grupo @admin-team a <#${newSlackChannelId}>:`, error.data ? error.data.error : error.message);
                // await say(`Advertencia: Ocurrió un error al intentar invitar al @admin-team.`);
            }
        } else {
            console.log('[INFO] No se configuró adminTeamUserGroupId, no se invitará a ningún grupo de usuarios.');
        }
        
        const displayWhatsappId = whatsappChatId.includes('@') ? whatsappChatId.split('@')[0] : whatsappChatId;
        await say(`¡Canal <#${newSlackChannelId}> creado y enlazado con el chat de WhatsApp "${whatsappChatName}" (ID: ${displayWhatsappId})!`);
        lastDisplayedUnmappedChats = [];

    } catch (error) {
        console.error("Error en comando /createchannel:", error);
        await say("Hubo un error al procesar tu solicitud para /createchannel.");
    }
}


export function initializeSlack(passedWhatsappClient) {
    if (!passedWhatsappClient) {
        console.error('[ERROR] No se proporcionó un cliente de WhatsApp a initializeSlack');
        return;
    }
    
    const whatsappClient = passedWhatsappClient;
    console.log('[INFO] Inicializando listeners de eventos de Slack...');

    // Manejador para comandos genéricos (como /map, /status, /contacts)
    // Registrar manejadores específicos PRIMERO para que tengan prioridad
    app.command('/view', handleViewCommand);
    app.command('/createchannel', handleCreateChannelCommand);

    // Manejador para comandos genéricos (como /map, /status, etc.)
    // Excluimos los comandos que ya tienen manejadores específicos
    app.command(/^\/((?!view|contacts|createchannel).*)/i, async ({ command, ack, say, respond }) => {
        // Acusar recibo inmediatamente
        await ack();

        // Prevenir procesamiento duplicado por reintentos de Slack
        if (command.trigger_id && processedCommandTriggerIds.has(command.trigger_id)) {
            console.log(`[INFO SLACK COMMAND] Comando con trigger_id ${command.trigger_id} ya procesado. Ignorando.`);
            return;
        }
        if (command.trigger_id) {
            processedCommandTriggerIds.add(command.trigger_id);
            // Limpiar el trigger_id después de un tiempo para evitar que el Set crezca indefinidamente
            setTimeout(() => {
                processedCommandTriggerIds.delete(command.trigger_id);
            }, MESSAGE_TS_TTL); // Usar la misma TTL que para los mensajes
        }

        console.log(`[INFO SLACK COMMAND] Comando recibido: ${command.command} ${command.text}`);

        if (commandCallbackInstance) {
            try {
                const responseText = await commandCallbackInstance(command.command, command.text);
                if (responseText) {
                    // Usar respond() para respuestas efímeras o en el mismo contexto.
                    // Usar say() para mensajes públicos en el canal.
                    // Para la mayoría de los comandos de utilidad, respond() es adecuado.
                    await respond(responseText);
                } else {
                    await respond("El comando se ejecutó, pero no hubo una respuesta textual.");
                }
            } catch (error) {
                console.error(`[ERROR SLACK COMMAND] Error ejecutando el callback del comando ${command.command}:`, error);
                await respond("Hubo un error interno al procesar tu comando.");
            }
        } else {
            console.warn(`[WARN SLACK COMMAND] commandCallbackInstance no está definida. Comando ${command.command} no procesado.`);
            await respond(`El comando ${command.command} no pudo ser procesado por el bot en este momento.`);
        }
    });



    app.message(async ({ message, context, client, say }) => {
        if (message.ts && processedMessageTimestamps.has(message.ts)) {
            console.log(`[INFO SLACK] Mensaje con ts ${message.ts} ya procesado o en cola. Ignorando reintento/duplicado.`);
            return;
        }
        if (message.ts) {
            processedMessageTimestamps.add(message.ts);
            setTimeout(() => {
                processedMessageTimestamps.delete(message.ts);
            }, MESSAGE_TS_TTL);
        }

        if (context.retryNum) {
            console.log(`[INFO SLACK] Procesando reintento de Slack. Intento: ${context.retryNum}, Razón: ${context.retryReason}, Evento TS: ${message.ts}`);
        }
        if (message.subtype && message.subtype === 'channel_join') {
            console.log(`[INFO SLACK] Bot añadido al canal ${message.channel}. No se procesa como mensaje.`);
            return;
        }

        if (message.bot_id === slackConfig.botId) { // slackConfig.botId debe ser el ID del bot (Bxxxxxxx)
            console.log(`[INFO SLACK] Mensaje de nuestro propio bot (bot_id: ${message.bot_id}), ignorando para evitar eco.`);
            return;
        }
        
        // Este es el ID de usuario del bot (Uxxxxxxx), puede ser útil si message.bot_id no está presente pero message.user es el bot.
        // const botUserId = context.botUserId || (await client.auth.test()).user_id; 
        // if (message.user === botUserId) {
        //    console.log(`[INFO SLACK] Mensaje del usuario del bot (user: ${message.user}), ignorando.`);
        //    return;
        // }


        if (message.subtype && message.subtype === 'bot_message') {
             // Si tienes el bot_id de tu app, puedes ser más específico:
             // if (message.bot_id && message.bot_id === slackConfig.botId) { ... }
             // O si quieres ignorar todos los mensajes de bot que no sean el tuyo:
             // if (message.bot_id && message.bot_id !== slackConfig.myActualBotAppBotId) { ... }
            console.log(`[INFO SLACK] Mensaje de subtipo 'bot_message' (User: ${message.user || 'N/A'}, bot_id: ${message.bot_id || 'N/A'}), ignorando por ahora.`);
            return;
        }

        if (message.thread_ts && message.ts !== message.thread_ts && !message.reply_broadcast) {
            console.log(`[INFO SLACK] Respuesta de hilo (ts: ${message.ts}) no enviada al canal, ignorando.`);
            return;
        }

        console.log(`[INFO SLACK] Mensaje recibido de Slack en canal ${message.channel} por usuario ${message.user}:`, message.text?.substring(0, 50) || '(sin texto)');

        if (!message.text && (!message.files || message.files.length === 0)) {
            return;
        }

        if (message.subtype && message.subtype !== 'file_share' && message.subtype !== 'thread_broadcast') {
            console.log(`[DEBUG SLACK] Mensaje con subtipo ${message.subtype} ignorado.`);
            return;
        }

        try {
            const slackChannelId = message.channel;
            const senderUserId = message.user;
            const messageText = message.text || '';
            // const messageTs = message.ts; // No usado directamente para enviar
            let attachments = [];

            if (message.files && message.files.length > 0) {
                for (const file of message.files) {
                    try {
                        console.log(`[INFO SLACK] Descargando archivo de Slack: ${file.name} (${file.url_private_download})`);
                        const fileBuffer = await downloadFile(file.url_private_download);
                        attachments.push({
                            buffer: fileBuffer,
                            mimetype: file.mimetype,
                            filename: file.name,
                            // Usar el texto del mensaje como caption si el archivo es el único contenido o si no hay caption específico
                            caption: message.text || '' 
                        });
                        console.log(`[INFO SLACK] Archivo "${file.name}" descargado.`);
                    } catch (downloadError) {
                        console.error(`[ERROR SLACK] Error descargando archivo ${file.name}:`, downloadError);
                    }
                }
            }

            const whatsappJid = await getWhatsAppJidForSlackChannel(slackChannelId);

            if (whatsappJid) {
                console.log(`[INFO SLACK] Mapeo encontrado: Canal Slack ${slackChannelId} -> WhatsApp JID ${whatsappJid}`);
                let senderDisplayName = senderUserId;
                try {
                    const userInfo = await client.users.info({ user: senderUserId });
                    if (userInfo.ok && userInfo.user) {
                        senderDisplayName = userInfo.user.profile?.display_name || userInfo.user.real_name || userInfo.user.name;
                    }
                } catch (userError) {
                    console.warn(`[WARN SLACK] No se pudo obtener info del usuario ${senderUserId}:`, userError.message);
                }

                const messagePrefix = `*[${senderDisplayName}]:*\n`;
                
                if (attachments.length > 0) {
                    for (let i = 0; i < attachments.length; i++) {
                        const attachment = attachments[i];
                        try {
                            console.log(`[INFO SLACK] Procesando archivo para WhatsApp: ${attachment.filename}`);
                            const fileType = MediaHandler.getFileType(attachment.filename, attachment.mimetype);
                            let friendlyFileType;
                            switch (fileType) {
                                case 'image': friendlyFileType = 'Foto'; break;
                                case 'video': friendlyFileType = 'Video'; break;
                                case 'audio': friendlyFileType = 'Audio'; break;
                                default: friendlyFileType = 'Archivo';
                            }
                            
                            // Usar el caption del attachment (que es el texto del mensaje original)
                            // solo para el primer archivo si hay texto, o para todos si no hay texto.
                            // O, si cada archivo debe llevar el texto, entonces siempre.
                            // Para simplificar, si hay texto, se envía después de todos los archivos.
                            // Si no hay texto, el caption del primer archivo puede ser usado.
                            
                            let captionForMedia = `*[${senderDisplayName}]* envió un ${friendlyFileType}: ${attachment.filename}`;
                            if (i === 0 && messageText) { // Si es el primer archivo y hay texto general, no añadir caption aquí, se enviará después.
                                // captionForMedia = undefined; // O una versión más simple
                            } else if (!messageText) {
                                // captionForMedia se mantiene
                            }


                            const tempFilePath = MediaHandler.saveBufferToTempFile(
                                attachment.buffer, 
                                path.extname(attachment.filename)
                            );
                            
                            try {
                                let messageConfig = {};
                                if (attachment.buffer.length > 10 * 1024 * 1024 || fileType === 'document') { // >10MB o es doc
                                    messageConfig = {
                                        document: fs.readFileSync(tempFilePath),
                                        mimetype: attachment.mimetype,
                                        fileName: attachment.filename,
                                        caption: (i === 0 && messageText) ? messagePrefix + messageText : captionForMedia // Adjuntar texto principal al primer doc
                                    };
                                } else {
                                    switch (fileType) {
                                        case 'image':
                                            messageConfig = { image: fs.readFileSync(tempFilePath), mimetype: attachment.mimetype, caption: (i === 0 && messageText) ? messagePrefix + messageText : captionForMedia };
                                            break;
                                        case 'video':
                                            messageConfig = { video: fs.readFileSync(tempFilePath), mimetype: attachment.mimetype, caption: (i === 0 && messageText) ? messagePrefix + messageText : captionForMedia };
                                            break;
                                        case 'audio':
                                            messageConfig = { audio: fs.readFileSync(tempFilePath), mimetype: attachment.mimetype };
                                            // Si es audio y hay texto, enviar texto por separado
                                            if (i === 0 && messageText) await whatsappClient.sendMessage(whatsappJid, { text: messagePrefix + messageText });
                                            else if (!messageText) await whatsappClient.sendMessage(whatsappJid, { text: captionForMedia }); // Enviar nombre de archivo si no hay texto
                                            break;
                                        default: // Documento por defecto
                                             messageConfig = { document: fs.readFileSync(tempFilePath), mimetype: attachment.mimetype, fileName: attachment.filename, caption: (i === 0 && messageText) ? messagePrefix + messageText : captionForMedia };
                                    }
                                }
                                
                                if (Object.keys(messageConfig).length > 0) {
                                   await whatsappClient.sendMessage(whatsappJid, messageConfig);
                                }
                                
                                // Si hay múltiples archivos y texto, el texto se adjunta al primero.
                                // Si no, y hay texto, y este no es el primer archivo, no se reenvía el texto.
                                // Esto evita enviar el texto general múltiples veces.
                                // El texto general se maneja después del bucle si no se adjuntó al primer archivo.

                            } finally {
                                MediaHandler.deleteTempFile(tempFilePath);
                            }
                        } catch (fileError) {
                            console.error(`[ERROR SLACK] Error procesando archivo ${attachment.filename}:`, fileError);
                        }
                    }
                    // Si hubo archivos Y texto, y el texto no se envió con el primer archivo (ej. audio), enviarlo ahora.
                    // Esta lógica es compleja. Simplificación: si hay texto y archivos, el texto se envía con el primer archivo (si es posible)
                    // o como mensaje separado si el primer archivo no admite caption (audio).
                    // Si el texto no se envió con el primer archivo (ej. porque era audio), y hay texto, enviarlo ahora.
                    const firstAttachmentWasAudio = attachments.length > 0 && MediaHandler.getFileType(attachments[0].filename, attachments[0].mimetype) === 'audio';
                    if (messageText && attachments.length > 0 && firstAttachmentWasAudio) {
                        // Ya se envió para audio
                    } else if (messageText && attachments.length > 0 && !firstAttachmentWasAudio) {
                        // Ya se envió con el primer archivo que no era audio
                    } else if (messageText && attachments.length === 0) {
                        // Solo texto, se maneja abajo
                    }


                } else if (messageText) { // Solo texto, sin archivos
                    await whatsappClient.sendMessage(whatsappJid, { text: messagePrefix + messageText });
                }

            } else {
                console.log(`[INFO SLACK] No se encontró mapeo de WhatsApp para el canal de Slack ${slackChannelId}. Mensaje no reenviado.`);
                // Opcional: Notificar al usuario en Slack que el canal no está mapeado
                // await say("Este canal de Slack no está conectado a ningún chat de WhatsApp. Usa `/map` si quieres conectarlo.");
            }

        } catch (error) {
            console.error('[ERROR SLACK] Error procesando mensaje de Slack para WhatsApp:', error);
        }
    });

    const existingCommandHandler = async ({ command, ack, respond, body }) => {
        const triggerId = body.trigger_id;
        if (processedCommandTriggerIds.has(triggerId)) {
            console.log(`[INFO SLACK] Comando con trigger_id ${triggerId} ya procesado. Ignorando.`);
            await ack();
            return;
        }
        processedCommandTriggerIds.add(triggerId);
        setTimeout(() => processedCommandTriggerIds.delete(triggerId), MESSAGE_TS_TTL);

        await ack();
        console.log(`[DEBUG] Comando Slack existente recibido: ${command.command} ${command.text}`);
        
        // Aquí iría la lógica para los comandos /status, /map, /unmap, /listmaps
        // Esta parte necesitaría ser provista o adaptada desde tu server.js o donde esté definida.
        // Por ahora, solo responderé que el comando fue recibido.
        // IMPORTANTE: Si estos comandos modifican `groupMappings`, deben ser actualizados
        // para usar la nueva estructura de `db.addMapping` y `db.getMapping`.
        try {
            // Simulación de un callback de comando existente
            if (config.commandCallback) { // Asumiendo que tienes un commandCallback en config
                 const responseText = await config.commandCallback(command.command, command.text, db /* pasar db para que pueda usarlo */);
                 await respond(responseText);
            } else {
                await respond(`Comando '${command.command}' recibido, pero no hay un manejador detallado configurado en slack-handler.js para él. La funcionalidad completa para este comando debe ser implementada o migrada aquí, asegurando que use la nueva estructura de base de datos si interactúa con los mapeos.`);
            }
        } catch (error) {
            console.error(`[ERROR SLACK] Error en manejador de comando existente ${command.command}:`, error);
            await respond("Error procesando este comando.");
        }
    };

    try {
        app.command('/status', existingCommandHandler);
        app.command('/map', existingCommandHandler); // Podría necesitar actualización si lo usas
        app.command('/unmap', existingCommandHandler); // Podría necesitar actualización
        app.command('/listmaps', existingCommandHandler); // Podría necesitar actualización

        // Nuevos comandos
        app.command('/view', handleViewCommand);
        
        // Manejador directo para comando /contacts
        app.command('/contacts', async ({ command, ack, respond }) => {
            await ack();
            console.log(`[INFO SLACK] Recibiendo comando /contacts: ${command.text}`);
            
            try {
                const args = command.text ? command.text.trim().split(' ') : [];
                const subCommand = args[0]?.toLowerCase();
                await db.read(); // Asegurarse que la DB está actualizada

                if (subCommand === 'new') {
                    // /contacts new 573301233042 Pepito Perez - Admin
                    const phoneNumber = args[1];
                    const nameAndRoleString = args.slice(2).join(' ');
                    const parts = nameAndRoleString.split(' - ');
                    const name = parts[0]?.trim();
                    const role = parts[1]?.trim();

                    if (!phoneNumber || !name || !role) {
                        return await respond('Uso incorrecto. Formato: `/contacts new <numero_telefono> <nombre_completo> - <rol>`\nEjemplo: `/contacts new 573001234567 Juan Perez - Cliente`');
                    }
                    if (!/^\d+$/.test(phoneNumber)) {
                        return await respond('Error: El número de teléfono solo debe contener dígitos.');
                    }

                    try {
                        const newContact = await addContact(phoneNumber, name, role);
                        return await respond(`✅ Contacto añadido: ${newContact.name} (${newContact.role}) con el número ${newContact.whatsappId}.`);
                    } catch (error) {
                        console.error('Error al añadir contacto:', error);
                        return await respond('❌ Error al añadir el contacto. Revisa los logs.');
                    }
                } else if (subCommand === 'view') {
                    const contacts = getAllContacts();
                    const contactList = Object.entries(contacts);

                    if (contactList.length === 0) {
                        return await respond('No hay contactos guardados. Usa `/contacts new` para añadir uno.');
                    }

                    let response = '*Lista de Contactos Guardados:*\n';
                    contactList.forEach(([whatsappId, nameAndRole]) => {
                        response += `- *${whatsappId}*: ${nameAndRole}\n`;
                    });
                    return await respond(response);
                } else if (subCommand === 'edit') {
                    // /contacts edit 573301233042 Pepito Perez - Actualizado
                    const phoneNumber = args[1];
                    const nameAndRoleString = args.slice(2).join(' ');
                    const parts = nameAndRoleString.split(' - ');
                    const newName = parts[0]?.trim();
                    const newRole = parts[1]?.trim();

                    if (!phoneNumber || !newName || !newRole) {
                        return await respond('Uso incorrecto. Formato: `/contacts edit <numero_telefono> <nuevo_nombre_completo> - <nuevo_rol>`\nEjemplo: `/contacts edit 573001234567 Juan Perez - Cliente VIP`');
                    }
                    if (!/^\d+$/.test(phoneNumber)) {
                        return await respond('Error: El número de teléfono solo debe contener dígitos.');
                    }

                    try {
                        const updatedContact = await editContact(phoneNumber, newName, newRole);
                        if (updatedContact) {
                            return await respond(`✅ Contacto actualizado: ${updatedContact.name} (${updatedContact.role}) para el número ${updatedContact.whatsappId}.`);
                        } else {
                            return await respond(`⚠️ No se encontró un contacto con el número ${phoneNumber}@s.whatsapp.net para editar.`);
                        }
                    } catch (error) {
                        console.error('Error al editar contacto:', error);
                        return await respond('❌ Error al editar el contacto. Revisa los logs.');
                    }
                } else {
                    return await respond('Subcomando de `/contacts` no reconocido. Usa `new`, `view` o `edit`.\nEjemplos:\n`/contacts new 573001234567 Juan Perez - Cliente`\n`/contacts view`\n`/contacts edit 573001234567 Juan Perez - Cliente VIP`');
                }
            } catch (error) {
                console.error(`[ERROR] Error en el manejador de /contacts:`, error);
                return await respond('Error interno al procesar el comando `/contacts`. Por favor, revisa los logs.');
            }
        });
        
        app.command('/createchannel', handleCreateChannelCommand);
        console.log('[DEBUG] Comandos registrados correctamente, incluyendo /view y /createchannel.');
    } catch (commandError) {
        console.error('[ERROR] Error al registrar comandos de Slack:', commandError);
    }

    app.error((error) => {
        console.error('[ERROR SLACK API]:', error);
    });
    
    (async () => {
        try {
            await app.start();
            console.log('⚡️ La app de Slack está corriendo y escuchando mensajes!');
            const authTest = await app.client.auth.test();
            console.log(`✅ Conectado como: ${authTest.user} en workspace: ${authTest.team}`);
            console.log(`🔹 ID de Usuario Bot: ${authTest.user_id}`); // Este es el context.botUserId
            // Guardar botUserId en db si es necesario para filtros más precisos
            // await db.read();
            // db.data.slackBotUserId = authTest.user_id;
            // await db.save(); // db.save() no existe, db.write() es llamado por addMapping, etc.
            // Si necesitas guardar esto, añade una función a database-handler.js
            if (slackConfig && !slackConfig.botId) {
                console.warn("[WARN] slackConfig.botId no está definido en config.js. Este ID (BXXXXX) es diferente al ID de usuario del bot (UXXXXX) y es útil para filtrar mensajes del propio bot.");
            }

        } catch (startError) {
            console.error('❌ Error al iniciar la app de Slack:', startError);
        }
    })();
    
    return app; // Devolver la instancia de la app si es necesario externamente
}

// Variable para almacenar la función callback que manejará los comandos
let commandCallbackInstance = null;
export function onSlackCommand(callback) {
    console.log('[DEBUG] Registrando callback para comandos generales de Slack');
    commandCallbackInstance = callback; // Este callback es el que se pasa desde server.js
    // El `existingCommandHandler` debería usar `commandCallbackInstance`
}

export { app as slackApp, webClient };