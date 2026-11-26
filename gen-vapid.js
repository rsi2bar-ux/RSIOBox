// node gen-vapid.js  -> prints a fresh VAPID key pair for push alerts
import { generateVapidKeys } from "./webpush.js";
const k = generateVapidKeys();
console.log("VAPID_PUBLIC_KEY=" + k.publicKey + "\nVAPID_PRIVATE_KEY=" + k.privateKey);
