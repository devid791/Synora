import {defineConfig} from '@playwright/test';
import base from './playwright.live.config';
export default defineConfig({...base,testMatch:'live-interactions.web.spec.ts',reporter:[['list'],['json',{outputFile:'test-results/live-interactions-web.json'}]],outputDir:'test-results/live-interactions-web'});
