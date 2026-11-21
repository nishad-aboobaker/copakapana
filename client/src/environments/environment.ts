const host = typeof window !== 'undefined' && window.location ? window.location.hostname : 'localhost';

export const environment = {
  production: false,
  apiUrl: `http://${host}:5000/api/v1`,
  wsUrl: `http://${host}:5000`,
};
