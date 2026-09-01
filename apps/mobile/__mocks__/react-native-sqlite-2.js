// Manual Jest mock: react-native-sqlite-2 needs a real native SQLite bridge,
// which doesn't exist in the Jest test environment. This fakes just enough
// of the WebSQL-style API for module-load-time `openDatabase()` calls (e.g.
// libraryStore.android.ts) to not crash component smoke tests.
const fakeResultSet = { insertId: 0, rowsAffected: 0, rows: { length: 0, item: () => null } };

const fakeTransaction = {
  executeSql: (_sql, _params, successCallback) => {
    successCallback?.(fakeTransaction, fakeResultSet);
  },
};

const fakeDatabase = {
  transaction: (callback) => callback(fakeTransaction),
};

export default {
  openDatabase: () => fakeDatabase,
};
