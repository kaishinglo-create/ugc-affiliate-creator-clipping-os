import { ollamaChat } from '../src/ollama.ts';

const result = await ollamaChat({
  prompt: 'Reply in exactly five words about clouds.',
});
console.log(JSON.stringify(result, null, 2));
