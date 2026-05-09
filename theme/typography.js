import { colors } from './colors';

// colors.text (#2a2b2b) = rgb(42, 43, 43)
//colors.textSubtle = 'rgba(42, 43, 43, 0.55)';
//colors.textFine   = 'rgba(42, 43, 43, 0.38)';

export const typography = {
    // Headers
    h1: {
        fontSize: 30,
        fontWeight: '700',
        letterSpacing: -0.5,
        color: colors.text,
    },
    h2: {
        fontSize: 24,
        fontWeight: '700',
        letterSpacing: -0.3,
        color: colors.text,
    },
    h3: {
        fontSize: 20,
        fontWeight: '600',
        letterSpacing: 0,
        color: colors.text,
    },
    h4: {
        fontSize: 17,
        fontWeight: '600',
        letterSpacing: 0.1,
        color: colors.text,
    },

    // Body
    body: {
        fontSize: 15,
        fontWeight: '400',
        lineHeight: 22,
        color: colors.text,
    },
    bodyBold: {
        fontSize: 15,
        fontWeight: '600',
        lineHeight: 22,
        color: colors.text,
    },

    // Labels
    label: {
        fontSize: 13,
        fontWeight: '500',
        letterSpacing: 0.2,
        color: colors.textSubtle,
    },
    labelSmall: {
        fontSize: 12,
        fontWeight: '400',
        letterSpacing: 0.2,
        color: colors.textSubtle,
    },

    // Fine print
    caption: {
        fontSize: 11,
        fontWeight: '400',
        letterSpacing: 0.3,
        color: colors.textFine,
    },
    overline: {
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: colors.textFine,
    },
};
