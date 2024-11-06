import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Ai } from '@cloudflare/ai';

type Env = {
    AI: Ai;
};

const app = new Hono<{ Bindings: Env }>();
app.use(cors());

app.post('/', async (c) => {

    let body;
    try {
        body = await c.req.json();
    } catch (error) {
        console.error("Error al parsear el cuerpo de la solicitud:", error);
        return c.text("Cuerpo de solicitud inválido o vacío", 400);
    }

    const messages: RoleScopedChatInput[] = body.messages;

    if (!body.messages || messages.length === 0) return c.text("No se han proporcionado mensajes", 400);

    const systemPrompt = 'Eres un asistente de soporte al usuario que responde a las preguntas del usuario en un idioma natural. Solo responde en español.';

    let stream;

    try {
        stream = await c.env.AI.run(
            // @ts-ignore
            "@cf/meta/llama-3.1-70b-instruct",
            {
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages,
                ] as RoleScopedChatInput[],
                stream: true,
                agreement: "Agreement",
            }
        ) as ReadableStream;
    } catch (error) {
        console.error("Error al ejecutar la API de AI:", error);
        return c.text("Error al procesar la solicitud", 500);
    }

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
        },
    });
});

export default app;

