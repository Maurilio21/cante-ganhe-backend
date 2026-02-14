
import axios from 'axios';

const taskId = "41bcf516c2206e4eb6021b72e7efdc3a";
const userId = "1";
const trackId = "06dcc3e3-b54b-4bf4-982f-e85db2cd738f";

async function fix() {
    try {
        console.log("Triggering status check to fix missing tracks...");
        const response = await axios.get(`http://localhost:3000/api/vocal-removal/status?taskId=${taskId}&userId=${userId}&trackId=${trackId}`);
        console.log("Response:", response.data);
    } catch (error) {
        console.error("Error:", error.message);
        if (error.response) console.error(error.response.data);
    }
}

fix();
