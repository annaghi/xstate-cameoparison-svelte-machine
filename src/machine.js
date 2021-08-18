import { assign, createMachine, send } from 'xstate';

import { ROUNDS_PER_GAME } from './constants.js';
import { select } from './select.js';
import { loadImage } from './utils.js';

const loadCelebs = async () => {
    const res = await fetch('https://cameo-explorer.netlify.app/celebs.json');
    const data = await res.json();

    const lookup = new Map();
    data.forEach((c) => {
        lookup.set(c.id, c);
    });

    const subset = new Set();
    data.forEach((celeb) => {
        if (celeb.reviews >= 50) {
            subset.add(celeb);
            celeb.similar.forEach((id) => {
                subset.add(lookup.get(id));
            });
        }
    });

    return {
        celebs: Array.from(subset),
        lookup
    };
};

const loadRounds = async (selection) =>
    selection.map((round) => Promise.all([loadCelebDetails(round.a), loadCelebDetails(round.b)]));

const loadCelebDetails = async (celeb) => {
    const res = await fetch(`https://cameo-explorer.netlify.app/celebs/${celeb.id}.json`);
    const details = await res.json();
    await loadImage(details.image);
    return details;
};

const initialGameContext = {
    rounds: [],
    currentRound: [],
    currentRoundIndex: 0,
    results: Array(ROUNDS_PER_GAME),
    currentResult: undefined
};

export const machine = createMachine({
    id: 'app',
    context: {
        celebs: [],
        lookup: undefined,
        selectedCategory: undefined,
        ...initialGameContext
    },

    initial: 'welcome',
    states: {
        welcome: {
            initial: 'idle',
            states: {
                idle: {
                    on: {
                        LOAD_CELEBS: 'loadingCelebs',
                        SELECT_CATEGORY: {
                            cond: (context, event) => context.celebs.length > 0 && context?.lookup,
                            actions: [
                                send({ type: 'PLAY' }),
                                assign({ selectedCategory: (context, event) => event.category })
                            ]
                        }
                    }
                },
                loadingCelebs: {
                    invoke: {
                        src: (context, event) => loadCelebs(),
                        onDone: {
                            target: 'idle',
                            actions: assign({
                                celebs: (context, event) => event.data.celebs,
                                lookup: (context, event) => event.data.lookup
                            })
                        },
                        onError: {
                            target: 'failure'
                        }
                    }
                },
                failure: {
                    on: {
                        RETRY: 'loadingCelebs'
                    }
                }
            }
        },

        game: {
            initial: 'idle',
            states: {
                idle: {
                    on: {
                        LOAD_ROUNDS: 'loadingRounds'
                    }
                },
                loadingRounds: {
                    entry: assign(initialGameContext),
                    invoke: {
                        src: (context, event) =>
                            loadRounds(
                                select(context.celebs, context.lookup, context.selectedCategory.slug, ROUNDS_PER_GAME)
                            ),
                        onDone: {
                            target: 'loadingRound',
                            actions: assign({ rounds: (context, event) => event.data })
                        },
                        onError: 'failure'
                    }
                },
                loadingRound: {
                    invoke: {
                        src: (context, event) => context.rounds[context.currentRoundIndex].then((round) => round),
                        onDone: {
                            target: 'question',
                            actions: assign({ currentRound: (context, event) => event.data })
                        },
                        onError: 'failure'
                    }
                },
                question: {
                    on: {
                        ATTEMPT: {
                            target: 'answer',
                            actions: assign({
                                currentResult: (context, event) =>
                                    Math.sign(event.a.price - event.b.price) === event.sign ? 'right' : 'wrong'
                            })
                        }
                    }
                },
                answer: {
                    after: {
                        1500: {
                            target: 'next',
                            actions: assign({
                                results: (context, event) => [
                                    ...context.results.slice(0, context.currentRoundIndex),
                                    context.currentResult,
                                    ...context.results.slice(context.currentRoundIndex + 1)
                                ]
                            })
                        }
                    }
                },
                next: {
                    after: {
                        500: [
                            {
                                cond: (context, event) => context.currentRoundIndex < ROUNDS_PER_GAME - 1,
                                target: 'loadingRound',
                                actions: assign({
                                    currentRoundIndex: (context, event) => context.currentRoundIndex + 1
                                })
                            },
                            {
                                target: 'feedback'
                            }
                        ]
                    }
                },
                feedback: {
                    on: {
                        RESTART: { actions: send('GREET') }
                    }
                },
                failure: {
                    on: {
                        RETRY: { actions: send('ERROR') }
                    }
                }
            }
        }
    },

    on: {
        GREET: 'welcome',
        PLAY: 'game',
        ERROR: 'welcome'
    }
});
