import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from 'discord.js';

interface BlacklistResponse {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

export function buildBlacklistResponse(reason: string, client?: Client): BlacklistResponse {
    const footerData: any = {
        text: 'Alice • Appeal if you believe this is an error',
    };

    if (client?.user) {
        footerData.iconURL = client.user.displayAvatarURL();
    }

    const embed = new EmbedBuilder()
        .setTitle('🌸 Access Restricted')
        .setColor(0xffb7e1)
        .setDescription(
            '```md\n' +
            '# Sorry, you can\'t use Alice right now!\n' +
            'Your access has been *suspended* due to:\n' +
            `> **${reason}**\n` +
            '```\n' +
            'If you think this is a mistake, you can appeal below! 💌'
        )
        .setFooter(footerData);

    const appealButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setLabel('✨ Appeal Suspension ✨')
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.gg/tqrVhMaUt')
    );

    return {
        embeds: [embed],
        components: [appealButton],
    };
}
