// media-handler.js
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de la carpeta temporal
const TEMP_DIR = path.join(__dirname, 'temp_media');

// Asegurar que exista la carpeta temporal
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Clase para manejar archivos multimedia entre WhatsApp y Slack
 */
class MediaHandler {
    /**
     * Obtiene la extensión de archivo a partir de un MIME type.
     * @param {String} mimeType - El MIME type (ej. 'image/jpeg').
     * @returns {String} - La extensión del archivo (ej. '.jpg') o una cadena vacía si no se reconoce.
     */
    static getExtensionFromMimeType(mimeType) {
        if (!mimeType) return '';
        const parts = mimeType.split('/');
        let subtype = parts[1];
        if (subtype && subtype.includes(';')) {
            subtype = subtype.split(';')[0];
        }

        // Mapeos comunes, se pueden expandir según sea necesario
        const mimeMap = {
            // Imágenes
            'jpeg': '.jpg',
            'png': '.png',
            'gif': '.gif',
            'webp': '.webp',
            'svg+xml': '.svg',
            'bmp': '.bmp',
            'tiff': '.tiff',
            // Videos
            'mp4': '.mp4',
            'mpeg': '.mpeg',
            'ogg': '.ogv', // video/ogg
            'webm': '.webm',
            'quicktime': '.mov',
            'x-msvideo': '.avi',
            // Audio
            // 'mpeg' para audio/mpeg (MP3) ya está arriba, podría causar conflicto si no se diferencia
            // Para ser más específico para audio:
            'aac': '.aac',
            'opus': '.opus',
            'wav': '.wav',
            'webm': '.weba', // audio/webm
            'ogg': '.ogg', // audio/ogg (WhatsApp usa .ogg para audios)
            // Documentos y otros
            'pdf': '.pdf',
            'msword': '.doc',
            'vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'vnd.ms-excel': '.xls',
            'vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
            'vnd.ms-powerpoint': '.ppt',
            'vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
            'zip': '.zip',
            'x-rar-compressed': '.rar',
            'plain': '.txt', // text/plain
            'html': '.html',
            'css': '.css',
            'javascript': '.js',
            'json': '.json',
            'xml': '.xml',
        };

        if (subtype && mimeMap[subtype]) {
            return mimeMap[subtype];
        }
        
        // Fallback para tipos comunes si el subtype exacto no está en el mapa principal
        if (mimeType.startsWith('audio/mpeg')) return '.mp3'; // Específico para MP3

        console.warn(`[MediaHandler] No se pudo determinar la extensión para el MIME type: ${mimeType}`);
        return ''; // O un genérico como '.bin' si se prefiere
    }

    /**
     * Guarda un buffer de datos en un archivo temporal
     * @param {Buffer} buffer - Buffer de datos del archivo
     * @param {String} fileExt - Extensión del archivo (con punto incluido)
     * @returns {String} - Ruta del archivo temporal
     */
    static saveBufferToTempFile(buffer, fileExt = '') {
        const fileName = `${uuidv4()}${fileExt}`;
        const filePath = path.join(TEMP_DIR, fileName);
        
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    /**
     * Elimina un archivo temporal
     * @param {String} filePath - Ruta del archivo a eliminar
     */
    static deleteTempFile(filePath) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /**
     * Determina el tipo de archivo según su extensión o MIME type
     * @param {String} fileName - Nombre del archivo o extensión
     * @param {String} mimeType - MIME type del archivo
     * @returns {String} - Tipo de archivo (image, video, audio, document)
     */
    static getFileType(fileName, mimeType) {
        // Si hay MIME type, usarlo como prioridad
        if (mimeType) {
            if (mimeType.startsWith('image/')) return 'image';
            if (mimeType.startsWith('video/')) return 'video';
            if (mimeType.startsWith('audio/')) return 'audio';
            return 'document';
        }
        
        // Si no hay MIME type, intentar determinar por la extensión
        if (!fileName) return 'document';
        
        const ext = path.extname(fileName).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm'];
        const audioExts = ['.mp3', '.ogg', '.wav', '.m4a', '.aac'];
        
        if (imageExts.includes(ext)) return 'image';
        if (videoExts.includes(ext)) return 'video';
        if (audioExts.includes(ext)) return 'audio';
        return 'document';
    }

    /**
     * Descarga un archivo de Slack
     * @param {Object} file - Objeto de archivo de Slack
     * @param {String} token - Token de Slack para autenticación
     * @returns {Promise<Object>} - Objeto con buffer, tipo, nombre y extensión
     */
    static async downloadSlackFile(file, token) {
        try {
            const response = await fetch(file.url_private_download, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) {
                throw new Error(`Error descargando archivo: ${response.statusText}`);
            }
            
            const buffer = await response.buffer();
            const fileExt = path.extname(file.name);
            const fileType = this.getFileType(file.name, file.mimetype);
            
            return {
                buffer,
                type: fileType,
                name: file.name,
                extension: fileExt,
                mimetype: file.mimetype
            };
        } catch (error) {
            console.error('Error descargando archivo de Slack:', error);
            throw error;
        }
    }

    /**
     * Determina el tipo de medio de un mensaje de WhatsApp.
     * @param {Object} message - El objeto message de Baileys (waMsg.message).
     * @returns {String|null} - Tipo de medio ('image', 'video', 'audio', 'document', 'sticker') o null.
     */
    static getWhatsAppMediaType(message) {
        if (!message) return null;
        if (message.imageMessage) return 'image';
        if (message.videoMessage) return 'video';
        if (message.audioMessage) return 'audio';
        if (message.documentMessage) return 'document';
        if (message.stickerMessage) return 'sticker'; // Consideramos sticker como un tipo de imagen para Slack
        return null;
    }

    /**
     * Extrae el caption de un mensaje multimedia de WhatsApp.
     * @param {Object} message - El objeto message de Baileys (waMsg.message).
     * @returns {String|null} - El caption o null si no existe.
     */
    static getWhatsAppMediaCaption(message) {
        if (!message) return null;
        if (message.imageMessage?.caption) return message.imageMessage.caption;
        if (message.videoMessage?.caption) return message.videoMessage.caption;
        if (message.documentMessage?.caption) return message.documentMessage.caption;
        // Audio y stickers no suelen tener un campo 'caption' estándar en Baileys de la misma manera.
        return null;
    }

    /**
     * Convierte el objeto de archivo de WhatsApp a un formato adecuado para enviar a Slack
     * @param {Object} waMsg - Mensaje de WhatsApp con archivo adjunto
     * @param {Function} downloadCallback - Función para descargar el archivo (normalmente waClient.downloadMedia)
     * @returns {Promise<Object>} - Objeto con buffer, tipo, nombre y extensión
     */
    static async processWhatsAppMedia(waMsg, downloadCallback) {
        try {
            let mediaObj = null;
            let caption = '';
            let fileName = '';
            let fileExt = '';
            let fileType = 'document';
            let mimeType = '';
            
            // Determinar el tipo de archivo en el mensaje
            if (waMsg.message?.imageMessage) {
                mediaObj = waMsg.message.imageMessage;
                caption = mediaObj.caption || '';
                fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '.jpg'; // Fallback a .jpg
                fileName = `${uuidv4()}${fileExt}`;
                fileType = 'image';
                mimeType = mediaObj.mimetype;
            } else if (waMsg.message?.videoMessage) {
                mediaObj = waMsg.message.videoMessage;
                caption = mediaObj.caption || '';
                fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '.mp4'; // Fallback a .mp4
                fileName = `${uuidv4()}${fileExt}`;
                fileType = 'video';
                mimeType = mediaObj.mimetype;
            } else if (waMsg.message?.audioMessage) {
                mediaObj = waMsg.message.audioMessage;
                fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '.mp3'; // Fallback a .mp3
                fileName = `${uuidv4()}${fileExt}`;
                fileType = 'audio';
                mimeType = mediaObj.mimetype;
            } else if (waMsg.message?.documentMessage) {
                mediaObj = waMsg.message.documentMessage;
                caption = mediaObj.caption || '';
                if (mediaObj.fileName) {
                    const originalExt = path.extname(mediaObj.fileName);
                    if (originalExt) {
                        fileName = mediaObj.fileName; // Usar nombre original si tiene extensión
                    } else {
                        // Si no tiene extensión, añadirla desde el mimetype
                        fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '';
                        fileName = `${mediaObj.fileName}${fileExt}`;
                    }
                } else {
                    fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '.bin'; // Fallback a .bin para desconocido
                    fileName = `${uuidv4()}${fileExt}`;
                }
                fileType = 'document';
                mimeType = mediaObj.mimetype;
            } else if (waMsg.message?.stickerMessage) {
                mediaObj = waMsg.message.stickerMessage;
                // Los stickers de WhatsApp suelen ser webp
                fileExt = this.getExtensionFromMimeType(mediaObj.mimetype) || '.webp';
                fileName = `${uuidv4()}${fileExt}`;
                fileType = 'image';
                mimeType = mediaObj.mimetype;
            } else {
                return null; // No es un mensaje con multimedia
            }
            
            // Descargar el archivo
            // downloadMediaMessage (usado dentro de downloadCallback) espera el objeto proto.IWebMessageInfo completo (waMsg)
            const buffer = await downloadCallback(waMsg);
            
            return {
                buffer,
                caption,
                type: fileType,
                name: fileName, // Este es el nombre que se usará para Slack
                originalFileName: mediaObj.fileName, // Guardamos el nombre original si existe (para documentos)
                mimetype: mimeType
            };
        } catch (error) {
            console.error('Error procesando archivo de WhatsApp:', error);
            throw error;
        }
    }

    /**
     * Limpia archivos temporales antiguos (más de 1 hora)
     */
    static cleanupOldTempFiles() {
        try {
            const files = fs.readdirSync(TEMP_DIR);
            const now = Date.now();
            const oneHour = 60 * 60 * 1000; // 1 hora en milisegundos
            
            files.forEach(file => {
                const filePath = path.join(TEMP_DIR, file);
                const stats = fs.statSync(filePath);
                const fileAge = now - stats.mtimeMs;
                
                if (fileAge > oneHour) {
                    fs.unlinkSync(filePath);
                    console.log(`Archivo temporal eliminado: ${filePath}`);
                }
            });
        } catch (error) {
            console.error('Error limpiando archivos temporales:', error);
        }
    }
}

// Programar limpieza de archivos cada hora
setInterval(() => {
    MediaHandler.cleanupOldTempFiles();
}, 60 * 60 * 1000); // 1 hora

export default MediaHandler;
