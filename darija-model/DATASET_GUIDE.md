# Dataset guide

The seed dataset is intentionally tiny and synthetic. It is for pipeline testing only, not for a production model.

## Recommended production mixture

Target at least tens of thousands of carefully reviewed examples before expecting a strong specialized assistant.

Suggested categories:
- 25% natural everyday Darija conversations
- 15% Arabizi normalization and response
- 15% Arabic-script Darija
- 10% French/Darija code-switching
- 10% practical Moroccan administration/customer support
- 10% writing/rewrite/translation
- 10% reasoning and instruction-following in Darija
- 5% safety, refusals and ambiguity handling

## Quality labels

Each example should carry internal metadata during curation:
- script: arabic | arabizi | mixed
- region: neutral | casa | rabat | north | fes | other
- register: casual | polite | professional
- quality: 1-5
- source/license
- reviewer status

Do not train on private user conversations without explicit permission.
