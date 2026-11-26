/**
 * 使用 Web Crypto 在扩展本地加密保存 API 密钥。
 * 加密密钥保存在当前扩展自己的 IndexedDB 中，不会进入 chrome.storage.local。
 */

const DATABASE_NAME = 'video-ad-guard-secret-storage';
const DATABASE_VERSION = 1;
const KEY_STORE_NAME = 'keys';
const STORAGE_KEY_ID = 'api-key-storage';
const ENCRYPTED_PREFIX = 'v1:';

interface EncryptedSecretPayload {
  iv: string;
  data: string;
}

let storageKeyPromise: Promise<CryptoKey> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
        request.result.createObjectStore(KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地密钥存储'));
  });
}

async function loadOrCreateStorageKey(): Promise<CryptoKey> {
  const database = await openDatabase();
  try {
    const storedKey = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(KEY_STORE_NAME).get(STORAGE_KEY_ID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法读取本地加密密钥'));
    });

    if (storedKey instanceof CryptoKey) return storedKey;

    const generatedKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
      const request = transaction.objectStore(KEY_STORE_NAME).put(generatedKey, STORAGE_KEY_ID);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('无法保存本地加密密钥'));
    });

    return generatedKey;
  } finally {
    database.close();
  }
}

function getStorageKey(): Promise<CryptoKey> {
  if (!storageKeyPromise) {
    storageKeyPromise = loadOrCreateStorageKey().catch((error) => {
      storageKeyPromise = null;
      throw error;
    });
  }
  return storageKeyPromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/** 加密单个 API 密钥，返回可写入 chrome.storage.local 的字符串。 */
export async function encryptSecret(value: string): Promise<string> {
  if (!value) return '';

  const key = await getStorageKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(value),
  );
  const payload: EncryptedSecretPayload = {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
  return `${ENCRYPTED_PREFIX}${JSON.stringify(payload)}`;
}

/** 解密 API 密钥，同时兼容旧版本保存的明文值。 */
export async function decryptSecret(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value) return '';
  if (!isEncryptedSecret(value)) return value;

  const payload = JSON.parse(value.slice(ENCRYPTED_PREFIX.length)) as EncryptedSecretPayload;
  if (!payload.iv || !payload.data) throw new Error('本地 API 密钥数据格式无效');

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesToArrayBuffer(base64ToBytes(payload.iv)) },
    await getStorageKey(),
    bytesToArrayBuffer(base64ToBytes(payload.data)),
  );
  return new TextDecoder().decode(decrypted);
}

/** 加密按服务地址保存的 API 密钥映射。 */
export async function encryptSecretMap(value: unknown): Promise<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const entries = Object.entries(value as Record<string, unknown>);
  const encryptedEntries = await Promise.all(
    entries.map(async ([key, secret]) => [key, await encryptSecret(typeof secret === 'string' ? secret : '')] as const),
  );
  return Object.fromEntries(encryptedEntries.filter(([, secret]) => secret));
}

/** 解密按服务地址保存的 API 密钥映射。 */
export async function decryptSecretMap(value: unknown): Promise<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const entries = Object.entries(value as Record<string, unknown>);
  const decryptedEntries = await Promise.all(
    entries.map(async ([key, secret]) => [key, await decryptSecret(secret)] as const),
  );
  return Object.fromEntries(decryptedEntries.filter(([, secret]) => secret));
}
