// Local memory of Buddy in IndexedDB. Nothing here leaves the device.
// If IndexedDB is unavailable (some private modes), falls back to memory and reports persistent: false.

const DB_NAME = 'buddy';
const DB_VERSION = 1;

let storagePromise = null;

export function openStorage() {
  storagePromise ??= createStorage();
  return storagePromise;
}

const now = () => new Date().toISOString();

async function createStorage() {
  try {
    return idbStorage(await openDb());
  } catch (error) {
    console.warn('IndexedDB недоступен, память будет только до закрытия страницы:', error);
    return memoryStorage();
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB не поддерживается'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile');
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbStorage(db) {
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);

  return {
    persistent: true,

    async getProfile() {
      return (await request(store('profile').get('me'))) ?? null;
    },

    saveProfile(patch) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('profile', 'readwrite');
        const profile = tx.objectStore('profile');
        let next;
        const get = profile.get('me');
        get.onsuccess = () => {
          next = { createdAt: now(), ...get.result, ...patch, updatedAt: now() };
          profile.put(next, 'me');
        };
        tx.oncomplete = () => resolve(next);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },

    addMessage(role, text) {
      return request(store('messages', 'readwrite').add({ role, text, at: now() }));
    },

    recentMessages(limit) {
      return new Promise((resolve, reject) => {
        const result = [];
        const cursorRequest = store('messages').openCursor(null, 'prev');
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor && result.length < limit) {
            result.push(cursor.value);
            cursor.continue();
          } else {
            resolve(result.reverse());
          }
        };
        cursorRequest.onerror = () => reject(cursorRequest.error);
      });
    },

    async deleteAll() {
      db.close();
      storagePromise = null;
      await request(indexedDB.deleteDatabase(DB_NAME));
    },
  };
}

function memoryStorage() {
  let profile = null;
  let messages = [];
  return {
    persistent: false,
    async getProfile() {
      return profile;
    },
    async saveProfile(patch) {
      profile = { createdAt: now(), ...profile, ...patch, updatedAt: now() };
      return profile;
    },
    async addMessage(role, text) {
      messages.push({ id: messages.length + 1, role, text, at: now() });
    },
    async recentMessages(limit) {
      return messages.slice(-limit);
    },
    async deleteAll() {
      profile = null;
      messages = [];
      storagePromise = null;
    },
  };
}
