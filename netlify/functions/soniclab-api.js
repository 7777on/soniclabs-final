/// Importa 'node-fetch' para hacer llamadas a APIs externas en un entorno Node.js
const fetch = require('node-fetch');

// Define la función principal que manejará las peticiones (handler)
exports.handler = async (event, context) => {
    // Solo permite peticiones de tipo POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // Extrae las claves de API de las variables de entorno seguras de Netlify
        const { GEMINI_API_KEY, REPLICATE_API_KEY } = process.env;
        const body = JSON.parse(event.body);
        const { toolId, toolType, inputs } = body;

        // Lógica para llamar a la API de Gemini
        if (toolType.startsWith('gemini')) {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
            const payload = { contents: [{ parts: [{ text: inputs.prompt }] }] };
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error?.message || 'Error en la API de Gemini.');
            }

            const result = await response.json();
            const textContent = result.candidates[0].content.parts[0].text;

            // Si es una herramienta de imagen, hacemos una segunda llamada a la API de Imagen
            if (toolType === 'gemini-image') {
                const imageUrl = await callImageAPI(textContent.split('**Tip de Oro')[0], GEMINI_API_KEY);
                return { statusCode: 200, body: JSON.stringify({ type: 'gemini-image', data: imageUrl }) };
            }

            return { statusCode: 200, body: JSON.stringify({ type: toolType, data: textContent }) };
        }

        // Lógica para llamar a la API de Replicate
        if (toolType.startsWith('replicate')) {
            const startResponse = await fetch('https://api.replicate.com/v1/predictions', {
                method: 'POST',
                headers: { 
                    'Authorization': `Token ${REPLICATE_API_KEY}`, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ version: inputs.model, input: inputs.replicate_payload })
            });

            let prediction = await startResponse.json();
            if (startResponse.status !== 201) throw new Error(prediction.detail || "Error al iniciar la tarea en Replicate.");

            while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
                await new Promise(resolve => setTimeout(resolve, 2500));
                const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, { 
                    headers: { 'Authorization': `Token ${REPLICATE_API_KEY}` } 
                });
                prediction = await pollResponse.json();
                if (pollResponse.status !== 200) throw new Error(prediction.detail || "Error al consultar el estado de la tarea.");
            }

            if (prediction.status === 'failed') throw new Error(`La tarea en Replicate falló: ${prediction.error}`);
            
            return { statusCode: 200, body: JSON.stringify({ type: toolType, data: prediction.output }) };
        }
        
        // Lógica para la herramienta híbrida de Mastering
        if (toolType === 'hybrid-mastering') {
             // 1. Análisis con Gemini
            const briefPrompt = `Actúa como un ingeniero de mastering de clase mundial. Voy a masterizar una canción. ${inputs.replicate_payload.reference_audio ? 'Quiero que suene como la canción de referencia que he subido.' : 'No tengo una referencia.'} Describe en 3 puntos clave un plan de mastering para darle potencia, claridad y un carácter comercial.`;
            const brief = await callGeminiAPI(briefPrompt, GEMINI_API_KEY);

            // 2. Procesamiento con Replicate
            const audioUrl = await callReplicateAPI('cjwbw/audiotools-v1:9a73e059728551733696536675a6493dfd08b3303530f78275508be61036815a', { input_audio: inputs.replicate_payload.userTrack, reference_audio: inputs.replicate_payload.referenceTrack }, REPLICATE_API_KEY);

            return { statusCode: 200, body: JSON.stringify({ type: 'hybrid-mastering', brief, audioUrl }) };
        }


    } catch (error) {
        console.error('Error en la función del servidor:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};

// Funciones auxiliares para mantener el código limpio
async function callImageAPI(prompt, apiKey) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
    const payload = { instances: [{ prompt: prompt }], parameters: { "sampleCount": 1 } };
    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Error en la API de Imagen.');
    }
    const result = await response.json();
    if (result.predictions && result.predictions[0]?.bytesBase64Encoded) {
        return `data:image/png;base64,${result.predictions[0].bytesBase64Encoded}`;
    }
    throw new Error("No se pudo generar la imagen.");
}

async function callGeminiAPI(prompt, apiKey) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Error en la API de Gemini.');
    }
    const result = await response.json();
    return result.candidates[0].content.parts[0].text;
}

async function callReplicateAPI(model, input, apiKey) {
    const startResponse = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: model, input: input })
    });
    let prediction = await startResponse.json();
    if (startResponse.status !== 201) throw new Error(prediction.detail || "Error al iniciar la tarea en Replicate.");

    while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 2500));
        const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, { headers: { 'Authorization': `Token ${apiKey}` } });
        prediction = await pollResponse.json();
        if (pollResponse.status !== 200) throw new Error(prediction.detail || "Error al consultar el estado de la tarea.");
    }
    if (prediction.status === 'failed') throw new Error(`La tarea en Replicate falló: ${prediction.error}`);
    return prediction.output;
}
