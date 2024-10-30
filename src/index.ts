import { Hono } from 'hono';
import { cors } from 'hono/cors'
import { Ai } from '@cloudflare/ai';

type Env = {
	AI: Ai;
  };

const app = new Hono<{ Bindings: Env }>();
app.use(cors());

app.get('/query', async (c) => {
	const question = c.req.query('text');
	if (!question || question.trim().length < 1) return c.text('Escribe una solicitud valida')

	const systemPrompt = 'Eres un asistente de conversación que responde a las preguntas de los usuarios en un estilo natural. Responde solo en Español, evita responder dos veces en diferente idioma, solo se requiere el texto en español'

	const response = await c.env.AI.run(
	  	"@cf/mistral/mistral-7b-instruct-v0.2-lora",
	  	{
			messages: [
				{ role: 'system', content: systemPrompt },
		  		{ role: 'user', content: question }
			] as RoleScopedChatInput[]
	  	}
	) as AiTextGenerationOutput

	return response ? c.text((response as any).response) : c.text("Hubo un error generando la respuesta, por favor vuelve a interarlo", 500)
})

export default app;
