import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
} from 'discord.js';
import { Blacklist } from '../db/database.js';

interface BlacklistResponse {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}

export async function isBlacklisted(userId: string, client?: Client): Promise<BlacklistResponse | null> {
    if (await Blacklist.isBlacklisted(userId)) {
        const reason = await Blacklist.getReason(userId) || 'Multiple policy violations';

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

    return null;
}