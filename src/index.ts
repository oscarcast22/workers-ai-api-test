import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Ai } from '@cloudflare/ai';

type Env = {
    AI: Ai;
};

const app = new Hono<{ Bindings: Env }>();
app.use(cors());

app.get('/query', async (c) => {
    const question = c.req.query('text');
    if (!question || question.trim().length < 1) return c.text('Escribe una solicitud valida');

    const systemPrompt = 'Eres un asistente de conversación que responde a las preguntas de los usuarios en un estilo natural. Responde solo en Español, evita responder dos veces en diferente idioma, solo se requiere el texto en español';

    let aiStream;
    try {
        aiStream = await c.env.AI.run(
            "@cf/mistral/mistral-7b-instruct-v0.2-lora",
            {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: question }
                ] as RoleScopedChatInput[],
                stream: true,
            }
        ) as ReadableStream;
    } catch (error) {
        console.error("Error al ejecutar la API de AI:", error);
        return c.text("Error al procesar la solicitud", 500);
    }

    const stream = new ReadableStream({
        async start(controller) {
            const reader = aiStream.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunkText = decoder.decode(value).trim();
                    if (chunkText.startsWith('data: ')) {
                        const dataText = chunkText.slice(6);
                        if (dataText === '[DONE]') break;

                        try {
                            const parsed = JSON.parse(dataText);
                            const { response } = parsed;

                            if (response) {
                                controller.enqueue(new TextEncoder().encode(response));
                            }
                        } catch (e) {
                            console.error("Error al parsear el chunk:", e);
                        }
                    }
                }
            } catch (e) {
                console.error("Error al leer el stream:", e);
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
    });
});

export default app;
