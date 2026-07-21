import './app.css';
import './lib/theme'; // side-effect: apply theme + wire postMessage
import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app')! });

export default app;
