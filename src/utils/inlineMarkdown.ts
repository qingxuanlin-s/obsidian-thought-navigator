import MarkdownIt from 'markdown-it';

// One parser per plugin module; callers keep their existing content/DOM caches.
const parser = new MarkdownIt({ html: true, linkify: true });
parser.linkify.set({ fuzzyEmail: false, fuzzyLink: true });

parser.inline.ruler.before('link', 'zk_wikilink', (state, silent) => {
	const start = state.pos;
	const embed = state.src.startsWith('![[', start);
	if (!embed && !state.src.startsWith('[[', start)) return false;
	if (state.linkLevel > 0) return false;
	const contentStart = start + (embed ? 3 : 2);
	const end = state.src.indexOf(']]', contentStart);
	if (end < 0 || end + 2 > state.posMax) return false;
	const content = state.src.slice(contentStart, end);
	if (!content || content.includes('\n')) return false;
	if (!silent) {
		const token = state.push(embed ? 'zk_embed' : 'zk_wikilink', '', 0);
		token.content = content;
	}
	state.pos = end + 2;
	return true;
});

parser.inline.ruler.before('escape', 'zk_math', (state, silent) => {
	if (state.src[state.pos] !== '$') return false;
	const match = state.src.slice(state.pos, state.posMax).match(/^(\${1,2})(?!\$)([^$\n]+?)\1(?!\$)/);
	if (!match) return false;
	// A closing currency/math dollar followed by whitespace must not start a formula.
	if (match[1] === '$' && /^\s|\s$/.test(match[2])) return false;
	if (!silent) {
		const token = state.push('zk_math', '', 0);
		token.content = match[2];
		token.markup = match[1];
	}
	state.pos += match[0].length;
	return true;
});

/** Parse inline syntax only. No Obsidian components, HTML rendering or layout work. */
export function parseInlineMarkdown(source: string): MarkdownIt.Token[] {
	return parser.parseInline(source, {})[0]?.children || [];
}

export interface InlineMarkdownHandlers {
	createExternalLink: (href: string) => HTMLAnchorElement;
	createInternalLink: (target: string) => HTMLElement;
	createEmbed: (target: string) => HTMLElement;
	renderMath: (expression: string, display: boolean) => HTMLElement;
}

/** Render tokens through DOM APIs; arbitrary HTML and event attributes stay inert. */
export function renderInlineMarkdown(container: HTMLElement, source: string, handlers: InlineMarkdownHandlers): void {
	const doc = container.ownerDocument;
	// Most nodes contain plain text: avoid allocating a token stream for them.
	if (!/[\\`*_[\]~<$&!\n:@.]/.test(source)) {
		container.appendChild(doc.createTextNode(source));
		return;
	}
	const stack: Array<{ el: HTMLElement; tag: string }> = [{ el: container, tag: '' }];
	const current = () => stack[stack.length - 1].el;
	const open = (el: HTMLElement, tag: string) => {
		current().appendChild(el);
		stack.push({ el, tag });
	};
	const close = (tag: string) => {
		if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop();
	};
	for (const token of parseInlineMarkdown(source)) {
		if (token.type === 'text' && !token.content) continue;
		switch (token.type) {
			case 'strong_open': case 'em_open': case 's_open':
				open(doc.createElement(token.tag), token.tag);
				break;
			case 'strong_close': case 'em_close': case 's_close': case 'link_close':
				close(token.tag);
				break;
			case 'link_open': {
				const link = handlers.createExternalLink(String(token.attrGet('href') || ''));
				link.textContent = '';
				const title = token.attrGet('title');
				if (title) link.title = String(title);
				open(link, 'a');
				break;
			}
			case 'code_inline': {
				const code = doc.createElement('code');
				code.textContent = token.content;
				current().appendChild(code);
				break;
			}
			case 'zk_wikilink':
				current().appendChild(handlers.createInternalLink(token.content));
				break;
			case 'zk_embed':
				current().appendChild(handlers.createEmbed(token.content));
				break;
			case 'zk_math':
				current().appendChild(handlers.renderMath(token.content, token.markup === '$$'));
				break;
			case 'html_inline': {
				// Preserve the formatting emitted by the selection toolbar, including nesting.
				const tag = token.content.match(/^<(u|span)(?:\s+style\s*=\s*(["'])(.*?)\2)?\s*>$/i);
				if (tag) {
					const el = doc.createElement(tag[1].toLowerCase());
					if (tag[3]) el.style.cssText = tag[3];
					open(el, tag[1].toLowerCase());
				} else if (/^<\/(u|span)\s*>$/i.test(token.content)) {
					close(token.content.match(/^<\/(u|span)/i)![1].toLowerCase());
				} else {
					current().appendChild(doc.createTextNode(token.content));
				}
				break;
			}
			case 'hardbreak':
				current().appendChild(doc.createElement('br'));
				break;
			case 'softbreak':
				current().appendChild(doc.createTextNode('\n'));
				break;
			default:
				current().appendChild(doc.createTextNode(token.content));
		}
	}
}
