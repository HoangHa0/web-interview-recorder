import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Use the official React plugin to process JSX
  plugins: [react()],
  
  // CRITICAL: Tells Vite that the 'client' directory is the root of the web content.
  // This is where it will look for index.html and App.jsx.
  root: 'client', 
  
  server: {
    // Set the host to true so it binds to 0.0.0.0 (necessary for some setups)
    host: true,
    // Set the frontend port to 3000 to avoid conflicting with the FastAPI backend (8000)
    port: 3000, 
  },
});