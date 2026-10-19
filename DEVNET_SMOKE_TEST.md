# Devnet smoke test

Run on 2026-10-16 against program `EaYBtMWdemH7szKjdtiti6iLgRi6HDTdqpsyk7qDwh49` (production build, verified byte for byte against the local build).

Market: `6RaChCCRW2UEG9ohmKdLb3fVQK5jA42LGt69b4oCvmeA`. Bettor 1 `HvVar2PhDyBybdQBRGpYq9nL2z4KanKuPPjo88GEFKkg` created it with 5 USDC on Yes. Bettor 2 `EddhXHsMv1odjjQBKmAkfFJUtZR7K31xLL1Sk6BJRoY1` bet 5 USDC on No. Dispute window for this market only: 60 seconds.

Result: resolved Yes about 32 minutes before the deadline (lock first). Winner received 9.900000 USDC (5 + 5 - 0.1 fee). Loser received 0. Fee vault received 0.100000 USDC. Vault left 0.

## Program deploys

| Step | Signature |
|---|---|
| initial deploy | [QAhnK365...](https://solscan.io/tx/QAhnK365Rmijy6bCDqMs2N94ZttvbkVxWamfm6a8V5SvtSr7epyQkpsECLWUDiNiV63QeBLts8HskkodQB9EYvd?cluster=devnet) |
| upgrade (lock_market, early Yes) | [66t4xHXs...](https://solscan.io/tx/66t4xHXsDkY1HsMUUTmXfrrh9Djcos6KfSmp4yz2sw3Qd7nG3QR9hnQCoGRdJm8e3YzUuTeV5jNxydCmNdvemBHt?cluster=devnet) |

## Successful transactions (in order)

| Step | Signature |
|---|---|
| initialize | [EbBCYEmS...](https://solscan.io/tx/EbBCYEmSTRVDA5kRtpWsKYPgeKYAxyX72LomVh1nGVoYNT8TiXwyMnwDEjhs3Q6A3mcSUTVhonvxoaLy5rx74Gv?cluster=devnet) |
| fund_sol_1 | [3Jxv2os4...](https://solscan.io/tx/3Jxv2os4rihKL4oR53Ex3cD3K4VnJdDFgdT2Z2TTT164ke2HQxPxY6R4bYcWPe1BzK3w2p9iimtTfdtRHS9ZA4Xg?cluster=devnet) |
| fund_usdc_1 | [52uSVro7...](https://solscan.io/tx/52uSVro7QbuFhY4ALvakubeckhHFDjVnTYCyQR8R4SXvYqWNNAoZNR7y3irCpZiWXX88tmmRYi2WhWAA9NUkRdZn?cluster=devnet) |
| fund_sol_2 | [caoNieLc...](https://solscan.io/tx/caoNieLcESnfbdGoZ7bANUVPq1WYCNUpzSFiU2hVGc5S7PnmjAqz2FbrGGK24iu9QX2ooJ9KNbi54WKiUoZmQ5B?cluster=devnet) |
| fund_usdc_2 | [66RBKuwb...](https://solscan.io/tx/66RBKuwbhBAR5hYcdgTFL6RnjgmhFq1bTi73GwNZfEyjijbB67KfuEoiRciz5d1mDNBt1oxsBL2g7ckYLagU6V3L?cluster=devnet) |
| set_limits_short | [39RMGNpc...](https://solscan.io/tx/39RMGNpc5PcGb1irnkJth9x6XN7QRaebULFbE7HXRrBZqkTBTe7Pvu3Yy46WDZXnwSE3CY21Vv1sJvgvrEdPhyi2?cluster=devnet) |
| create_market | [48htShhu...](https://solscan.io/tx/48htShhuNAJ8eAAGkuUi4JXHmth1JgrnyEu4VD3YhhWHTAFbNfQczhTvZEqkNQpqDJaZuicCHSRRcbA4sC1VYNHU?cluster=devnet) |
| set_limits_restore | [5pMHu8WP...](https://solscan.io/tx/5pMHu8WPhVsj7M4VdUsvP9CE9xKAhB2Cd1V6Hft3EATLW39B23b75HGnWzd6Xv5dehstVggwUUUwtayvbByHj9bc?cluster=devnet) |
| approve_market | [5nRpuKrj...](https://solscan.io/tx/5nRpuKrjCNCuVE7s5jDeABUAycGx1R6kfz4g14Nnh7h5Hpx3NXTneY1fVLfo3zdEaxN8w2nmngkVMSdwWF3LDDgj?cluster=devnet) |
| place_bet | [4Snu3pEZ...](https://solscan.io/tx/4Snu3pEZLburV5qVcDrGRFzN9aqrfyHc4aLYgeDLERcmV2CnXS3k6aMXxPhJau617DEnxDWzE4sAUKBJ345HBcQL?cluster=devnet) |
| lock_market | [czJvRwLZ...](https://solscan.io/tx/czJvRwLZ9T5GEgAsA9ZzeysaWwVBAhdrWqDMvd6zfYBqts79HnktFyrwTM5XgnzMqDGsEzd6m2HaN1CPcgKc4uc?cluster=devnet) |
| unlock_market | [5aiPToGQ...](https://solscan.io/tx/5aiPToGQVivPXCjL6SJkdRAgH3KCRu6vNzBVvAkTHnSj643v47PdUnFUzKU8SDQQaGWkjyeTsshoCh4roRpXEPWU?cluster=devnet) |
| lock_market_again | [48VQB1Nn...](https://solscan.io/tx/48VQB1NnNw5rUFYr6w98tkLUttRHB2yKuSx3iFEHQvAqUYKoRpDyDvyaGjf4QUr2CiBbf7BcRGie9FqCb7yoZ8xs?cluster=devnet) |
| resolve_market | [2Ty6Yegu...](https://solscan.io/tx/2Ty6YegupcQDWv9DQyqbju3rNKFWhFBDbs1eYVddT2u3tGa9hHTJYXg2G2jYiHZwARM1XvjxgcfXBu5DSMRZ7a5B?cluster=devnet) |
| claim_bettor1_winner | [4XsepUfo...](https://solscan.io/tx/4XsepUfozWvovWLFPx2Huitx5GEnQ1tuWpEWZM5ayScwVa6SXoE87f5snDP23shTW7CJMoqUeZiD6YUvdc7EdjF9?cluster=devnet) |
| claim_bettor2_loser | [7ywY8MMq...](https://solscan.io/tx/7ywY8MMqJ56qzW9r7wvs4p3xXXUusMv4tg1Mtu5rSktrHpd3u9kfTeZgBXjNPHvKayaqxpAdAmAu9jHb4sPcjw9?cluster=devnet) |
| collect_fees | [2TuHiRAp...](https://solscan.io/tx/2TuHiRApk7S468S7VUzqt4rncBoPBi61sHbzbLTBpaSMJSws8vuKcePAhv1R48i2BfseQmaBavACR2oKcMAPzSX?cluster=devnet) |

## Transactions that had to fail (and did)

Sent with preflight off so each failure is a real on chain transaction.

| Check | Expected error | Result | Signature |
|---|---|---|---|
| bet_other_side | OtherSide | failed as expected | [VSmKZciF...](https://solscan.io/tx/VSmKZciFPfUW2R4zaMwkJiXv21um8hLxudYkWemhcyfVKjz1AuX7ZNwwCgV76C4xTyppDtbQB9BZaryok8UujQ2?cluster=devnet) |
| bet_under_min | BadAmount | failed as expected | [2mVUJV3b...](https://solscan.io/tx/2mVUJV3bZaYZJ9FFngTJ1GBVj1r6vAaMjQhv1axtnqjzAYUivvzwr8P47HXQLtqkZ1VzurmAKBS2cKuwfLQ33A6J?cluster=devnet) |
| bet_over_max | OverMax | failed as expected | [ECyATH3j...](https://solscan.io/tx/ECyATH3jSFEWi2e8uLAmYV82sHKppYAkP9uNfqesibwuaFxkdzmUzG48Qc4MfzS9mjgSS6uLvpKhotGGpvx3bK6?cluster=devnet) |
| non_admin_resolve | Unauthorized | failed as expected | [kTZAoexW...](https://solscan.io/tx/kTZAoexW1cAQNKty5SqhnGqkQEpBWLVEjo83sSiFHjnAuZ364S2G5wEQGx6kKjGDvRNt94Rz7kUPui3xgapo2kh?cluster=devnet) |
| resolve_yes_before_deadline (original build, before lock existed) | TooEarly | failed as expected | [38p1UmGA...](https://solscan.io/tx/38p1UmGAdKgm2NWu3UjMsqw3CJVn8R97Mohx37rpixgG87kPsPXGVcFzPdg7HEqaGLoyxfJzADkcD6Nrsqrnx8qc?cluster=devnet) |
| claim_while_open | NotClaimable | failed as expected | [4Y2WAqZa...](https://solscan.io/tx/4Y2WAqZaGrw2z3QyyAsbXKuAhRFn3Hvk92CApqSrekoN1ZeqD4rvE4pnU2EtAEhKpczkyJDP1AMt7qSNQy73yiKH?cluster=devnet) |
| non_admin_lock | Unauthorized | failed as expected | [51vQm9AN...](https://solscan.io/tx/51vQm9ANzV6ZdyyAG2ua6T2FJ9Kyn1zwUAQ4w73AqnjNzex1b3zAWwHxraVgQEiKrsQ4ZF7PRygzK16T6ZaNV8Ay?cluster=devnet) |
| bet_while_locked | BadStatus | failed as expected | [nt3qLxHN...](https://solscan.io/tx/nt3qLxHNmRPqag2UUSKZruVqYs5dbnUfYGtnE2RuDPHmc8ARrTgNphsSbsPZozsXfD7U4WM2uy6oQsTNxixmoFs?cluster=devnet) |
| non_admin_unlock | Unauthorized | failed as expected | [58wnzLNm...](https://solscan.io/tx/58wnzLNmRZukE1b36WfKQmZJcGofyUnPYDtPWPg8gTkZyD45tT7QHkLr5sNxrUSo3fVdZEf9ndRzaUY3SWhjaQhr?cluster=devnet) |
| resolve_no_while_locked_before_deadline | TooEarly | failed as expected | [AtZghSPM...](https://solscan.io/tx/AtZghSPMEyhwT3Q8agsru1LG8PRxY6aDu8VKcPoxfiyH4DLAsNn35dPjpUcjXQRqabyquz4tL4RD13vEaMPiBW6?cluster=devnet) |
| claim_in_dispute_window | NotClaimable | failed as expected | [3u3UqiVZ...](https://solscan.io/tx/3u3UqiVZFknmmVsM7guGScq1vArf9bSgQQSC9FkTDfc2ELxH4r91LQEi1hYxYjpYbezCXuxzg7CisyZxFSP26xwz?cluster=devnet) |
| claim_twice | AlreadyClaimed | failed as expected | [4iczVRzs...](https://solscan.io/tx/4iczVRzsCBS7EJVHEzYdcqkooNsk1pNcSn2WST7apmrt2PprGft781VwAxSyEsf2Fo9bJEsEozM1eR2aAFdtKxDQ?cluster=devnet) |
| collect_fees_twice | AlreadyClaimed | failed as expected | [2CtNHkmh...](https://solscan.io/tx/2CtNHkmh4jzK2wRtsYLF5HzXWjZbC8guh7JJUigRcw4UbbvvKBzQLzaNFAduQWiXhH8hfQyh6rfFhbheY3b6HeHf?cluster=devnet) |

# Run 2 (5 minute payout window)

Market: `2gPRmMTB6fx2j2svHK2bFRLCYERCQEBDjqbQe6Gqe7XJ`. Same two bettors, 5 USDC Yes vs 5 USDC No. Locked, unlocked, locked again, resolved Yes before the deadline. Claims opened 300 seconds later. Winner 9.900000 USDC, loser 0, fee 0.100000 USDC, vault left 0. Afterwards admin moved to `7TPuntBHLRAyjBNKvMx24aKcXL9aGT2uaacUPJSWEMeF`.

| Step | Signature |
|---|---|
| create_market | [6bSjUUrR...](https://solscan.io/tx/6bSjUUrRufBh9CKdAPuRTsych5GZGxaCDFRnUC95w5dmd8QQuATczfwR1U9LM2RgCpgg8ySbAMqo53PGdXvTwNA?cluster=devnet) |
| approve_market | [zWi8rzpe...](https://solscan.io/tx/zWi8rzpeMeYGzqiWvJRw6e9tfaxkagGzwSdsUi8eRSQ8DUPL3Q9CtFQiJzmvkd2zgeLyMJVkmixkPBsQtfHAesS?cluster=devnet) |
| place_bet | [5UvWen1R...](https://solscan.io/tx/5UvWen1RTP37BPn9GRj4JVTaAreG6ZrqDBccVnUoUGgC3M32jM9BxqgE9D69vFSic2KcjPFYgeu7C8caCdWRCZy8?cluster=devnet) |
| lock_market | [5cJo36kF...](https://solscan.io/tx/5cJo36kFgxApt3A58SKVQc4JByy1dj79eap9tjR8a7ersSiSsKyNxrKFX4zjTNCVCY7hUesedmNMRB4uZa7E1WU4?cluster=devnet) |
| unlock_market | [4ga3n5pj...](https://solscan.io/tx/4ga3n5pjcNAdVNynCdLz1wKbn4Mqqmq2Ysdz8B8CfpC8GukgYC1FLce2Eqps4pB3KvWNzXC7vjQA3dHdF7UHGo9G?cluster=devnet) |
| lock_market_again | [44h9W5ft...](https://solscan.io/tx/44h9W5ftXosL9d8979oYcQLMBdJFHuqvQZ9ENqznVCuCmqpZmxuKtWYfuHhswRy9ctsDM4oTukLhs6uqs3eiJQJU?cluster=devnet) |
| resolve_market | [a1Qam4za...](https://solscan.io/tx/a1Qam4zaP7zMS6KUPbrFYCCY2AGz76FFtNfCc29W7FWMYkc2rEp3ERf61GFx356gqdkjYdQPVCLdBeMnHJnf1AY?cluster=devnet) |
| set_admin | [2cGcCsGe...](https://solscan.io/tx/2cGcCsGeiC1abTZMNLyusnf8ay8aeKKKygGej8q9UKzE6ssy2CNwP2896gv2yRDy1ruWgGkiWdQngdGju3SpZF9q?cluster=devnet) |
| claim_bettor1_winner | [FWKFksra...](https://solscan.io/tx/FWKFksrapNhmSBXLGqh1VWLf85UuDyfcuWG8dGu6ZWqdfreqkizLoLJjvhMz5iz2y1u2JTkeS6e9KKX2XKmtchD?cluster=devnet) |
| claim_bettor2_loser | [YMf1JtLi...](https://solscan.io/tx/YMf1JtLiqE4EyVTF1VVmh5BHzNDArTi8tPfLuWp9ARSKBnw9E5WTfQ868JRzcEpFz1vomiVAidV5mHdT7G5JiVg?cluster=devnet) |
| collect_fees | [5mBoKVGt...](https://solscan.io/tx/5mBoKVGtQiWny4xgqS5FYXhScrGcvs5qZWnJAT91tQGkwxEc7p9zeeswx7C3veYFUtfCnyvY5mHnC5S8STeU5ctU?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| bet_other_side | OtherSide | failed as expected | [3LpLogbK...](https://solscan.io/tx/3LpLogbKhUdFggHf42Jtjc8wSnseZ6d4dESrzBdSWpm2eyyR6RogywFmFbzkXp2QT6T2tz4ZHAsCUe6ztA6vbSzR?cluster=devnet) |
| bet_under_min | BadAmount | failed as expected | [2Tiypma7...](https://solscan.io/tx/2Tiypma7m9FnsbQMsBk1C7dGYv2U3fQVV2ToFq2xoDcoEunwv7JNM4cTavrAru9c98wstoeKcSUirXfCRUo7HFWe?cluster=devnet) |
| bet_over_max | OverMax | failed as expected | [5bC67frM...](https://solscan.io/tx/5bC67frMfTawikjxMfXpYGgWew1PPTj4miG7TPeW7k7uu2LsTkok3Dbg5X9cwWp9kMek7TJBhtGxofzzw2RnQYTT?cluster=devnet) |
| non_admin_resolve | Unauthorized | failed as expected | [5zZtzVBa...](https://solscan.io/tx/5zZtzVBam16pT51YQQMuixKhdTiZvnmTphzzQBQuNLsoT9P7367pDt9tAw6EMQbHa92oVG2y6v9zwGkjJGfv9de8?cluster=devnet) |
| resolve_no_before_deadline | TooEarly | failed as expected | [iABKjkBk...](https://solscan.io/tx/iABKjkBkZg18BaVNQxJnLPXKrekqbn1nhwwmA6ascBH7qKqRqzEGwYnfFYSyXe5ovyUhwKY5uk2KQePbL8betNC?cluster=devnet) |
| claim_while_open | NotClaimable | failed as expected | [3x6tqmy6...](https://solscan.io/tx/3x6tqmy6Pu6vkDXHKu3X5m9L6PfD6PmnhAyCzCUn6KTdfTbasneC8mUK78iLkJRsfW1whnmQZf8qARYZyFjrCcMG?cluster=devnet) |
| non_admin_lock | Unauthorized | failed as expected | [45WT4jjM...](https://solscan.io/tx/45WT4jjMSxMSaA1nddgpUykeDYcmbj6aTNiz4UtxLfbLH97fruYKfNqJQ75gsGsa6rwJUYRJanorBeR9mZEXEwZo?cluster=devnet) |
| bet_while_locked | BadStatus | failed as expected | [5LPBeZVT...](https://solscan.io/tx/5LPBeZVTqbYHjzB6qn8qarnUt5TyMqYUetKg1iooE3Qt6yTRBCTtbspPZJSNTXsBZ9jxCGQsCKJP7aqqkeBJP4KG?cluster=devnet) |
| non_admin_unlock | Unauthorized | failed as expected | [25w3SjR9...](https://solscan.io/tx/25w3SjR9HEm7MjmC8Q6wMcDYXJP8oydgZwoXcYv6idSJU8nR9ys3UiZ6t8aVjfp6zLmGr2CZDfuuiohrJYW2FitU?cluster=devnet) |
| resolve_no_while_locked_before_deadline | TooEarly | failed as expected | [4wPeg7L5...](https://solscan.io/tx/4wPeg7L5MqdNsTdGVhz7p8CHwmhJohTTZp49Na1Eg3wne7USAcR6sAa2uqUXLT9h4pdrfHhUiDxFkVsqCJKL3qSP?cluster=devnet) |
| claim_in_dispute_window | NotClaimable | failed as expected | [5ZFxJdyR...](https://solscan.io/tx/5ZFxJdyRGJgYy5Nd6sM3GkrtbeVVFNahpGug6y1NgwNfscvPATLEtpe4qgJD2MqtfBAFB1mw88skUEJ25SSVScGp?cluster=devnet) |
| claim_twice | AlreadyClaimed | failed as expected | [4Gqbm42x...](https://solscan.io/tx/4Gqbm42x3YSaoWwZkerNcMRAi9LbG7FZCewcbWTZAGAxx8MBr2HqppGtYb2MkkAES5rwJhka8RUuRjrCV5W99Tx5?cluster=devnet) |
| collect_fees_twice | AlreadyClaimed | failed as expected | [4HYet38D...](https://solscan.io/tx/4HYet38DMVeVY7aeXSaMZwC9CbWRVvGSt8XzYPMMqRMgUoPV5uPN2b13c5fxeoPKE7mTMYh9Hc2meSW3SGZXH5ya?cluster=devnet) |

# Run 3 (resolver key)

Market: `9p62fuZB3irFXpDQ26hnusNdjKGEGwEG7dhbnsLYcsHc`. Admin `7TPuntBHLRAyjBNKvMx24aKcXL9aGT2uaacUPJSWEMeF` set resolver `EskbinsytGLYYrbHgCnKvkZoQGEF5AzgiWzETxYk21Ss`. The resolver locked, unlocked, locked again and resolved Yes before the deadline. Winner 9.900000 USDC, loser 0.000000, fee 0.100000 USDC, vault left 0.

| Step | Signature |
|---|---|
| set_resolver | [3Ug5CSB1...](https://solscan.io/tx/3Ug5CSB1aaS6PTRUvLbGvWtQ3zBu42endoSKj8dZUkNYBbrFRKzJjv4qnyssPuwpGvw23Mdv9dG9TMuoMSho3UkE?cluster=devnet) |
| fund_resolver_sol | [tJwLpcSv...](https://solscan.io/tx/tJwLpcSvJYhMqk1PZpRrW6gKvXbyJKmYnfZgVkyVHmJfDYiScoxh31Gn3R9gzytNjZhCZGXnQPgmnFBz3UYLCti?cluster=devnet) |
| fund_usdc_bettor1 | [5MhPSxhm...](https://solscan.io/tx/5MhPSxhmBYdiC7xKhkeXmKG2tK1k7vKh8Q4pS4cYhVp414aucrJERkXmwVstxY82UspCpYuBNvA7H5dL55LjExfa?cluster=devnet) |
| fund_usdc_bettor2 | [UNRJEPSx...](https://solscan.io/tx/UNRJEPSxnfKdFhtsr2ed5N9Vs2ireyirWhVEbA7wcyxuTd5cK4kVw3uDRDwuJkLL7SSxskZFr2rJbzYURREyRGw?cluster=devnet) |
| create_market | [5kNhwXN8...](https://solscan.io/tx/5kNhwXN8R8NNzXfmnakehLzAKtJgPGF7QCXKXVP1qEAdSbDWocHgM8KvCjuKP2S2s28GcAYeFvATiyfr1TC2MTyW?cluster=devnet) |
| approve_market_by_admin | [4qssYeM1...](https://solscan.io/tx/4qssYeM1Lsvdc2GcPfbSeNoH2VsWh1iCbkt3BSFQm8qmJudHfV7RrpdjbEYU15LsBK1AQsbpM46U41nqvzEftiv4?cluster=devnet) |
| place_bet | [3Ykzh3VQ...](https://solscan.io/tx/3Ykzh3VQpTypKyjDR1hitH3uo8FHiAvWR3qRJMpy1nfGXcqGSA7yDyoWV3keknn3LwNLbEd9m7jgwBQk52T8K1de?cluster=devnet) |
| resolver_lock | [4pwca8NH...](https://solscan.io/tx/4pwca8NHzu8h2qUySrnzZPTjQtNhCB9ewHsyhTKJ67pk8pqqyMmDJUSRV7jbUT4o7L4QaYuzCxrQkNBziuaSdwUA?cluster=devnet) |
| resolver_unlock | [2PJ5RDVN...](https://solscan.io/tx/2PJ5RDVNcN9jvFTcHzQzzSX3bRxSHMbxMznKwadhawsUG3tzQe1NMTr1VudXZGGiMpc5DFx66JZym5QWPodoWiuU?cluster=devnet) |
| resolver_lock_again | [4B3tUzar...](https://solscan.io/tx/4B3tUzarTmeZUbcSKeTiA8SbFYauR5jyLY7uPgLM7Aa7SZju6wmusNSgdkhArV8Bu4JnbyQqHz6hy3XX5hSz1gQg?cluster=devnet) |
| resolver_resolve_yes | [2X2Wfguu...](https://solscan.io/tx/2X2WfguuiUUNmzL9FKBBzaWoPJeShoYt1fZutJA7v2D5rXd7SF4efqpKfffpFXeThRhptDYrLbfH8V731QaHWw7p?cluster=devnet) |
| claim_winner | [65MvoZds...](https://solscan.io/tx/65MvoZdsTSQnhGNYKdUYLZJ3tpW1pabY3gRVHfdysQ7PadhUoDh7WKsUdUPKbhUTWdvs7aicgjg7ci8AwVMGu7aa?cluster=devnet) |
| claim_loser | [4ofV2cwd...](https://solscan.io/tx/4ofV2cwdFUg4Ks7ywQdvd4sHJXX4ybXhmynBMerBYeqe3NQzs2UeSbtv3o3RZLZHc3RcmJdyqEnTxEc8AS5HPbxM?cluster=devnet) |
| collect_fees | [4cYRGbQq...](https://solscan.io/tx/4cYRGbQqjApMTHuFpTAHosnXn6c1NyUQ5d3HJW5rtYWpMKBsLhf8xEPhaxc3Vjv25fwegr4wSqvXrMgZixPQNiGm?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| resolver_void | Unauthorized | failed as expected | [u9EZwdPf...](https://solscan.io/tx/u9EZwdPfaEQiDbEhdRvwu4K3txBXQ4sgtnkJLnfPcSNquJYPEcXbei6BQM393TrArngFEUtM88B9q9iVfWQeWPc?cluster=devnet) |
| resolver_reject | Unauthorized | failed as expected | [2RnJGpnK...](https://solscan.io/tx/2RnJGpnKLth6MXfTSFn8Er6yKdNFKZJpzRZBrfibXXqdrMtHakiT7bERA7Y4ma16wUvnfut65n2RaH1ovmuqeV1?cluster=devnet) |
| resolver_settle_dispute | Unauthorized | failed as expected | [3uhSUDnK...](https://solscan.io/tx/3uhSUDnKQcQP8kadnqL6V1M7XtijnCpaJ6H5WGdLCPt4wXQG9USvGozut68kuKCHmnY58GnfMQd7VXS9iGi9mrDp?cluster=devnet) |
| resolver_pause | Unauthorized | failed as expected | [55X9eMU7...](https://solscan.io/tx/55X9eMU7D3Wb9usDHjHXZk5rEMvdUmXh8UUGNPcnNGtanWgVggqLeXnbNziu8XZwe1CAZHrbzJ6NX6yJtQCcgfrh?cluster=devnet) |
| resolver_set_limits | Unauthorized | failed as expected | [3ETr7qHf...](https://solscan.io/tx/3ETr7qHfa1gSTaNMkCo6hvYaJSXF9vhLPYX1GzLZ4iAo6Gvo2C6jAQtqJBq1ebs5YPgh9y8mEHR37zr7yuKqB9To?cluster=devnet) |
| resolver_set_admin | Unauthorized | failed as expected | [53Y7wD11...](https://solscan.io/tx/53Y7wD11t8C9X6bqxmimBf4YtVHuFvYknN9t1nSh3izLsHbWDVn65A7KaTqfbYeXWjFxKMbQGQFYi8FSkvULTrdb?cluster=devnet) |
| resolver_set_resolver | Unauthorized | failed as expected | [8m8MxNFB...](https://solscan.io/tx/8m8MxNFBiS6DjgG8ghrFLZBpsCD3HtDk522PgNV4v2Mwxbtsyxejppffz2bRQTtEBafJEeUeYnKv7PfuUw8NDPi?cluster=devnet) |
| bettor_lock | Unauthorized | failed as expected | [638X4kP5...](https://solscan.io/tx/638X4kP5LBnC47eXV9SiXJEB8UtXqMXx4LmEGq6BA4rRy34wUNwyD6MQKFxkQdk9AbZB4V7f3HtaGSVXiYLimUxy?cluster=devnet) |
| resolver_lock_without_resolver_config | Unauthorized | failed as expected | [skGRtchn...](https://solscan.io/tx/skGRtchnwanAd6AVYtu2JuXVq9uYv5rq9QBFDHn6P4w6qtFWz6ZryoEZkVsd1X358ZguttmyXNbtTCtPAajL8jC?cluster=devnet) |
| resolver_bet_while_locked_by_bettor | BadStatus | failed as expected | [3JatKeo7...](https://solscan.io/tx/3JatKeo7wiqjDFzccdXDoscYUe3Bi7P8kyLRJwP45e4LE2jtfWTfxf9mU85cL6eC5RbotyJ9heYg67BqqhA84aq2?cluster=devnet) |
| resolver_resolve_no_early | TooEarly | failed as expected | [5C2ytuTi...](https://solscan.io/tx/5C2ytuTiKHdZi8aLdubfmNGEqQ7HKgXRVkDGSBjJvsr7phDrZX5uPFAc2btsKR4gbkeXj683hLDXHHqvNG6NbTdr?cluster=devnet) |
| claim_twice | AlreadyClaimed | failed as expected | [5zvQgi9Y...](https://solscan.io/tx/5zvQgi9Y8QwoYrDZtUxN4SifKR9A8em5vt4bRxHeU9wLPDHtHAxwMS2f1DeiarcwFtPE2gkGea73LvppL7MqB9De?cluster=devnet) |

# Version 2 live run (share trading and cash out)

Program `3B84AX7kyaGSMrxyKZrJBng4MQtirx9CF1G54yGGL1RM`, market `4XmkkCp5dNLCdedvGuufRRrPB97BGzAW3Gd4hUTRLVDv`.

- Bettor 1 created the market buying Yes for 5.000000 USDC. Yes price 0.104880.
- Bettor 2 bought Yes for 6 USDC. Yes price rose to 0.110453.
- Bettor 1 cashed out all Yes shares for 5.219279 USDC: profit 0.219279 USDC after the 1% sell fee.
- Bettor 1 then bought No for 5 USDC (switched sides).
- The resolver key locked the market (buys and cash outs blocked) and resolved Yes before the deadline.
- Pot: Yes 5.780721 + No 5.000000 USDC. Winner (bettor 2) received 10.672914, loser 0, fee 0.107807 USDC to the admin wallet, vault left 0.000000.

| Step | Signature |
|---|---|
| initialize | [634mTfMD...](https://solscan.io/tx/634mTfMDfvwNh4SwVJrjvtEVGQptXj8JEab2hyKVqiAtjsLy2F3QoGNk9xNh41jv3ezVPEUFqkowaAnhX5FunKLk?cluster=devnet) |
| set_resolver | [2CUTZnr2...](https://solscan.io/tx/2CUTZnr2gjjFFY2vPE1PmEW2xvSQWksua3XWFx1WZY2Y1B6q7GmdACxmieDVLCX98mHeDwjvWvv9Uvau7ooCUtte?cluster=devnet) |
| set_admin | [fQiC79zE...](https://solscan.io/tx/fQiC79zEb4xWdZ5UecftwR4MGxDKDAdtvSCUP88J8CPcC53RTK82hW12kdR7Ju1e2bGTXjyVXKTRC6dY9Kbw2t6?cluster=devnet) |
| fund_bettor_sol | [1NBTDyHX...](https://solscan.io/tx/1NBTDyHXat9brRQwFMN5xi3E1ZiYZ2ESHqf8iLYKEjF3E9MEzJMthYMPvGJevjx4tRrDp5jG2SqANP876rGaA92?cluster=devnet) |
| fund_bettor2_usdc | [XgKuCEP3...](https://solscan.io/tx/XgKuCEP3AaRP4fhBdbLNAK5QQa5M3SXEZU5q6PQAWXF7koGVrboAwTSbCjg9fPBtBYQesbZhZbdcsgvjUtpELtv?cluster=devnet) |
| create_market_bettor1_yes_5 | [4GDur77U...](https://solscan.io/tx/4GDur77UNy5VgqazPdAzmC3Nq1MQk662DNy2j6a7i8LpRRsuWTRGhtVBWegcZtpeErkMPTvthMj7pGto5tuMetM7?cluster=devnet) |
| approve_by_admin | [2yB6tpMH...](https://solscan.io/tx/2yB6tpMH93BGg27qN6VzshmNQWNcxftE2iAchEAbJ7QvSQyvnsGAa3nKzdcaTR8UQWNHZWyEAabrtSvKn6f3VbYy?cluster=devnet) |
| bettor2_buy_yes_6 | [3Y4B7Q6n...](https://solscan.io/tx/3Y4B7Q6nNt9JHKeTkcyHHYSGz3h2AkjtEgbQKeSq626vVPHZHHRE5q9AJYGV7FpUydpn8gwFmaTgSVy2XeM3eiCZ?cluster=devnet) |
| bettor1_cash_out_all_yes | [4ZoCiKxk...](https://solscan.io/tx/4ZoCiKxk64nJzDWvrCNjZRjyJNzdwbwAgoyp5U4GY1Dhv8R6ho7MQE2Psqqd8TzAn1RtBbMaf1TKHkDe9qx2E69D?cluster=devnet) |
| bettor1_buy_no_5 | [Hm93pUiZ...](https://solscan.io/tx/Hm93pUiZwAc3BVLKFBJomt7L8PaY8D4GuuCvBW8zzVKLKQ48pPnKRtwpec2vweYAWwwcHfppyWw3vjwi7H7popt?cluster=devnet) |
| resolver_lock | [oDHh6nB2...](https://solscan.io/tx/oDHh6nB2BrJ2d7qMZc2pE5rhwE9zBxuHYyZzer1sSvjMcfdg73GR2LWmv5SEPM8DSaa5YiJMHkZjeLFE1UHtmsg?cluster=devnet) |
| resolver_resolve_yes_early | [3Y3fXTob...](https://solscan.io/tx/3Y3fXTobgyAQ3hcZrxwzrzJzBqaMiHy4QFENiyzixZ4mUMvVLnZCNmE2beeoxHzW1EFztUF2U4KKVW9nCCxMdS14?cluster=devnet) |
| claim_bettor2_yes_winner | [hvtv4UwM...](https://solscan.io/tx/hvtv4UwMzUhqxitRvjCWPgE9igouRDuTnqfvNpm6DAYgDvqFxXFjo6m7SdeLvrJNPxFWKAfMAovJbSVLaq8EXxf?cluster=devnet) |
| claim_bettor1_no_loser | [2BdCWzdj...](https://solscan.io/tx/2BdCWzdjWXfYTxk1dZHwPUDujbi2UvqnPheo3KhUJ4mqajfrTyiAgGLzP9VfwiyTiYF7E9uGuzJUU29vBJLfVYSV?cluster=devnet) |
| collect_fees | [LbLM9gAY...](https://solscan.io/tx/LbLM9gAYdb76BuNDXEPT5hCLzBrD3SiDFsATrUVoqupz96KNSeGTKEXXp7dGqmGJQBm5N54gJiPfgSnsX9g9mou?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| bettor2_buy_other_side | OtherSide | failed as expected | [4bnjexwX...](https://solscan.io/tx/4bnjexwX3XQa6PagNtCyF7YVntz8EwTgvFA4PwzZjFgksm1bP5S7aKcpmDiaB9qCtKLt26cBWa3tBvNaJg7zKhmM?cluster=devnet) |
| sell_more_than_held | NotEnoughShares | failed as expected | [2Vkzs5gC...](https://solscan.io/tx/2Vkzs5gCTXD8aJVZpopZCoJR3uVatr597QkCEXQW7CrKabmXGvko7qSyC3KG94b22NpZCdASbDijt5NRbyuiyV6c?cluster=devnet) |
| sell_slippage_guard | Slippage | failed as expected | [2gywfrP8...](https://solscan.io/tx/2gywfrP8YaFNDYCVUYJQFQfUJcs2268u545gZKYiddckxMy9g2YE3dY5YqbirdU8U2W9uca9btJSb4arKNs1sj96?cluster=devnet) |
| buy_under_min | BadAmount | failed as expected | [BLpV5gDM...](https://solscan.io/tx/BLpV5gDMaAgVb7jHvoTvC45zrq6RpH28b2yqzuDjdLgj3gDrjrkiUy8zPwtzqkXjoVNvwUD8WY9GHPnefTeyKAm?cluster=devnet) |
| buy_while_locked | BadStatus | failed as expected | [zEGhExGM...](https://solscan.io/tx/zEGhExGMEctjjSeNbE6WBN3tSEpvNrcxh4aHFonLBjz88qd9M5Tso2cyMwpUPfe9pNYUqXWG5GGpSz2bKXnUzHU?cluster=devnet) |
| cash_out_while_locked | BadStatus | failed as expected | [5kS4g9Cf...](https://solscan.io/tx/5kS4g9Cfj4ZDpmpU9bQ7euUotAZT5J63RV7vUMBm6v2T9jt2fTx9xVyo3xLy9YSwkGev3FV6RYvX69T1Z16CMwVf?cluster=devnet) |
| resolver_resolve_no_early | TooEarly | failed as expected | [TG6616Ui...](https://solscan.io/tx/TG6616UifkQWtXUqz9rNr5cTnzxrAm1Zc9oHnMHnkxS54WWfqKFR81ayWU3mCRShU82HF8m4KiJeYp4EVNMBzGp?cluster=devnet) |
| resolver_void | Unauthorized | failed as expected | [2z9ntYFz...](https://solscan.io/tx/2z9ntYFzSfQ6wYdmN6q48dxjAunUyeQagvq3inu8AaUsQoj7PrYkT9ZRRgmSScrKAuUjVV1S2QCBpmBG5V6V7Zb4?cluster=devnet) |
| claim_twice | AlreadyClaimed | failed as expected | [3vDaz1Jy...](https://solscan.io/tx/3vDaz1JySKJGd6Fr7vfrFcMytYPSGDpnf4iXeNeZhYe5MSSvbstBbKVjH9W5qXZMDSFS2rGq9TyCAupbpq8tqtdX?cluster=devnet) |

# Version 2.1 live run (orphaned fee sweep, after the upgrade)

Program upgraded in place to md5 `92d28ef47fa741fe88dfcbbad987d6fd` (SECURITY_REVIEW.md L-4). Upgrade signature [4BSgXDrW...](https://solscan.io/tx/4BSgXDrWeKaWmQo4YedBhmcjNfyLUTUMwxvZXXRRiadHubhhhcqWDrnyz56yKsUc4qMdDAgyXMzqU7gZzTsZtETH?cluster=devnet).

Market `A7XneN691yqvP8QozmCYsbNFP3MhgSHdMyjx9pexDn1n`. Bettor 2 created it with 5 USDC on Yes. Bettor 1 bought No for 5 USDC and then sold every No share, leaving 0 No shares and 0.050000 USDC of retained sell fees. The admin voided the market. Bettor 2 got back 5.000000 USDC (the whole Yes reserve), bettor 1 got 0.000000, and collect_fees swept 0.050000 USDC to the admin wallet. Vault left: 0.000000.

| Step | Signature |
|---|---|
| orphan_create_bettor2_yes_5 | [2JaDiWAA...](https://solscan.io/tx/2JaDiWAAjLAM97YkaxPGYWUJmCfFGf4TJT6wj3DTv4oBxdDtNBb528casw2tv5qvRrbGTr98DehwGHtLx9gnT5SN?cluster=devnet) |
| orphan_approve | [5Gj9ZN1q...](https://solscan.io/tx/5Gj9ZN1qKdPMxoGyKrx54oNh3inKaoYKDpdADFNai4ritgtLgmYdfwevp3geLAo7sAJoNia8Wt4CBGURtVSQq6rq?cluster=devnet) |
| orphan_bettor1_buy_no_5 | [d5L4uown...](https://solscan.io/tx/d5L4uown8pgKLRkzosRDo2Mnc5habshbu54PZ67FSd13yaQZ18kGyqHqDG8XbCvQxsSbeJX5CpnET3swcD2q3JU?cluster=devnet) |
| orphan_bettor1_sells_all_no | [4cEJYc4h...](https://solscan.io/tx/4cEJYc4hpkpXaPGDqeWxtAf5286rV5FHwWvCduFgfKPpJn2yr9G3QKJccVrgBVLN3Zo1DXs9PriuuHxr94f6DxRo?cluster=devnet) |
| orphan_admin_void | [4Vq3QsZf...](https://solscan.io/tx/4Vq3QsZfrh1Vrq4zsXdcAKefEfRzEGGKADGSEp6zKuCtvwv6xepPvUhSQcmN9Xdh6haWCLFgybPZTiWH1rT5HNDQ?cluster=devnet) |
| orphan_claim_bettor2_refund | [5e81KGfB...](https://solscan.io/tx/5e81KGfBkYKb3wQjKwPRfBV71jAk81yeMETX3KGbaC7Z98yZF8WLhW8JseLgQDzAFfEmm8rFbNRSAyzaRaUxCET2?cluster=devnet) |
| orphan_claim_bettor1_nothing | [bMLvNP47...](https://solscan.io/tx/bMLvNP47aFs9U8G5Ve5sw677Zit3G7XWHiNKAX1W7Ay5X6pqcKfXThXP5RJKJbm2FGA6w4GkJ2296BDK5y87842?cluster=devnet) |
| orphan_collect_fees_sweep | [3d5JfpCs...](https://solscan.io/tx/3d5JfpCsUGgfPfV5uUtf1PiV6WLrcDZhQzMoJ7xsyQposgDazEZo8GRqShyDCzHRMtRn1j1KQ2Tkm8qdefddagp2?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| orphan_collect_while_open | BadStatus | failed as expected | [46R99Nmg...](https://solscan.io/tx/46R99NmgRVQjGF4Gp1kSUwsYxD9H51Kr9JRPLybsJ5N5p74yqPFvqwAVTwwxZGZwDGht35zwKgdjzRbbUU7va9Zo?cluster=devnet) |

# Version 2.2 live run (automatic payouts)

Program upgraded in place to md5 `e9dc38193ac9a249d613e74f2c4dc862` (adds `claim_for`). Upgrade signature [5VUZKzTq...](https://solscan.io/tx/5VUZKzTqzmiCPbe7aQsMXPUoC3vVucU444vSUTB6ZxV56AgCae2y5uazi1o2DUPBRDQ4AsxB2wu9vwo5bG25ca6m?cluster=devnet).

Market `1RsA8a12Yfc5vDzfsUWZpSQ1Kdw4gPfSvGo3LBteUfk`. The admin wallet bought Yes for 5 USDC, bettor 2 bought No for 5 USDC. The resolver key locked and resolved Yes. After the 5 minute window, the devnet deployer wallet (no position in the market) sent both payouts with `claim_for`: the winner received 9.900000 USDC, the loser 0.000000, an unrelated wallet's balance changed by 0.000000. Fee 0.100000 USDC, vault left 0.000000.

| Step | Signature |
|---|---|
| auto_create_admin_yes_5 | [3eX4fB9n...](https://solscan.io/tx/3eX4fB9ncqjKSSqWgaAwQ2ZrqhBtVoZQBCnVTJkP9sVb7L8CMy3QygChzXpZykzSM4Rj6Ecxh3KrREtc2kiViXtu?cluster=devnet) |
| auto_approve | [4PRtJQvd...](https://solscan.io/tx/4PRtJQvd2StV4mhfASfckLmURiQPhj6kTDatYksCBSxfvp42Lz5gUxjZ2DmiEJUSxCP2aH1ENRysExUz5uH3cxau?cluster=devnet) |
| auto_fund_bettor2_usdc | [64ia6vxR...](https://solscan.io/tx/64ia6vxRNYnYUuJamxyD7X4pK41UtEKXEUMyW55U8UMEnUs4AMphg3ppYzxKyuT7AQRsHpu4inQd1SrkjzmLhnoH?cluster=devnet) |
| auto_bettor2_buy_no_5 | [64AzspbM...](https://solscan.io/tx/64AzspbM6ovsNpqEqSL7Wz5Q4t2fZzVBZNHJ97tZKRGpafM6ra3PJ9D5DCtwEGb8wv8FygGqSp36rFPUBWECBxH5?cluster=devnet) |
| auto_resolver_lock | [5UEDFi29...](https://solscan.io/tx/5UEDFi29BGvFCe6AbigqiE2M3nB7C5MupXP9q6sh9i5PDoMPepNCv3y5HetLniQWnjojGeBjpBKkYkqyYDThrGY3?cluster=devnet) |
| auto_resolver_resolve_yes | [2dHPuBCk...](https://solscan.io/tx/2dHPuBCkEbvd4Lfq6cVn7RKhZ2sLRqUGzRfJrWnKPe7vM7gEXYisTvGvHFdKkGMPx3GBF5Pin3mNCFkDQhdqGE4q?cluster=devnet) |
| auto_pay_winner_admin | [3oGaCGPM...](https://solscan.io/tx/3oGaCGPMGdW7HR1otG2uA34Uj89mDBXBa7rCoP6Fy1qHduST1yuTZjiVukQW4VieNkZvjq4FLYtcQVuuHigwSxVJ?cluster=devnet) |
| auto_pay_loser_bettor2 | [3zjDJirS...](https://solscan.io/tx/3zjDJirSBVogE39bGGFzHK3MfHSMnVdRE7uAcGD6zrYDg7vV8u7mxxFkstnVSRxEKcf9gXP3PS7PrNonmC5mRwMb?cluster=devnet) |
| auto_collect_fees | [2LC3VYmM...](https://solscan.io/tx/2LC3VYmMSJrPTMr1XYzvmozeWi383Pa4cx8GKL4MdT5doWTcJtD5H1LyoVQBfKY8opLNzqXzYb57DMyBMtuGB5pE?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| auto_redirect_to_caller_wallet | ConstraintTokenOwner | failed as expected | [3NYDeeLf...](https://solscan.io/tx/3NYDeeLf9mLXuFTPH5Thidz3XPUyufpH5QFPRNdZoS7mT9QFaYy8LMfT99vcivmVfCc8ER9JcC8DubH9jPysZoNk?cluster=devnet) |
| auto_pay_twice | AlreadyClaimed | failed as expected | [9hXQhGBr...](https://solscan.io/tx/9hXQhGBr4uw479TgLQCbLaVnnszvzj5ndQXm5FKr6LpUmbYxtQyuNFzNVLTDwibAnazyTemffe9pj44b2upofpp?cluster=devnet) |
| auto_then_manual_claim | AlreadyClaimed | failed as expected | [RiV9ykdj...](https://solscan.io/tx/RiV9ykdjezc7HQgYiryuzjS6Mtio4488CH8wP9s3psiJkyQuJt5qPUa96M47LkodXCjynAhns5RPVY7xHAqEp6f?cluster=devnet) |

# Version 3 live run (3 outcomes, open creation, creator fee, bonus, automatic payouts)

Program `BGCcEd1X76oZ2yF9nRoun2gGGLJC3D59Z2XEJNJ6KmhZ`, production build md5 `784f86c4096d25a7a707a7c4b11ab455`.

- Market A `5X4TUVQ8v45KGT1fQmKsux4v9wTdhCkfWpoNegZjzLTL`: created by the admin with 3 outcomes, so it opened instantly and Verified (open verified=true creatorShare=0). 5 USDC on each outcome plus a 3 USDC bonus from a treasury wallet. The resolver locked it and resolved outcome 3 early. Automatic payouts: outcome 3 holder 17.820000 USDC, the others 0. Platform fee 0.180000, vault left 0.000000.
- Market B `FPcQgfdCNEw4YDQMs3tVBtKJax9FRyE5pKU6Xyho9AWA`: created by a user while open creation was on with a 50% creator share (open verified=false creatorShare=5000). Resolved Yes early. Winner 9.900000 USDC, loser 0. Fee split: platform 0.050000, creator 0.050000 (paid to the creator's own account; paying it anywhere else was rejected). Vault left 0.000000.

| Step | Signature |
|---|---|
| initialize | [2kbbxwfh...](https://solscan.io/tx/2kbbxwfhsDiRFWPcoQo1WDk7x3KRrfS1Ryk4p61uQGa9wUjmWLzPdWKfGcpRcbmKntedaxsuzNsrE4R2pST6ZA2w?cluster=devnet) |
| set_resolver | [3yWa9vRT...](https://solscan.io/tx/3yWa9vRTrVFprdKEjSaHhwQb7r7v68E4n3Mh1ZDB4uXim4CSLw3Shk6dn3pY73hqBJ1SMX6twTQMyTymKodw7Ax5?cluster=devnet) |
| set_admin | [4M8Pmhah...](https://solscan.io/tx/4M8PmhahBiVbD3S8mnV5iBFmrZ4adw5VQZxDDYkbQtvvGHBisqPwGXfmkEh9T99YYVUg7r7CCzYtyRmbJXQUrK8p?cluster=devnet) |
| fund_sol | [2bRMHZSC...](https://solscan.io/tx/2bRMHZSCUWbEuZ6KYxvBR92ge4ddwEmQCrDuYZsc8MhDdoqzeGxBXSGiqdqDdKDmyBxBJyVwB2Xse5P9FayR8uSy?cluster=devnet) |
| fund_usdc_bettor1 | [47bMCJHw...](https://solscan.io/tx/47bMCJHwv38pgbPx5V5XTxZAWxZzsiJ3mMWh3Hz61iRx4skcb1Xe2UHGMuKEbV7mnKknsgZNSPXUKroM11AHuzFN?cluster=devnet) |
| fund_usdc_bettor2 | [3UDRGVvP...](https://solscan.io/tx/3UDRGVvPphvJk3WnKiuB4qyoA2irxb1zqJd9SoqacruUyr2Bn55mwRxK1ik2xTJZ22fgMVhuh5Hes83tWMeNPRKm?cluster=devnet) |
| a_admin_create_3_outcomes | [2xDSWVk9...](https://solscan.io/tx/2xDSWVk94Loe4c3qJ4FSiKpTDH5pmaRzXeH4VLZeYkS3wFojsG4ZKCoweHFNbfnYWU5NhYhX25NJW56CUWNFZ4Dg?cluster=devnet) |
| a_bettor1_buy_outcome2 | [5AE6LJtd...](https://solscan.io/tx/5AE6LJtdp6QUagTnsS45dMWwCH4f8Ltq6tZprZyADWLk69uczfFqvLZkV1D2Ks2NG9jxY1fpFHfZrRgd3bmBadPr?cluster=devnet) |
| a_bettor2_buy_outcome3 | [2jsUSeQV...](https://solscan.io/tx/2jsUSeQVXtNMxdpj44xvMhAmhcN6wYL8JWZvVXBXgMCKagNFhcPjebiTGV3zwbj16BJ3KXJi5ESqvEghET6ZWvXd?cluster=devnet) |
| fund_treasury_usdc | [3j6Wh826...](https://solscan.io/tx/3j6Wh826uY55VFXPXe6xU8m4MG8gcB3hJzofcdMuDzWZoVdo1wWZDURQPrxm8qLmUeJsoQLvQk7uw4TufPp8A5SM?cluster=devnet) |
| a_treasury_bonus_3 | [5Bedj1hB...](https://solscan.io/tx/5Bedj1hBcCHYRx4kDryhLMaJJq3XozQEPqr9NZ3JNwdAyxRyYRxBZjr1e1dH5KJKPmQU1teCodiJTfatQvo2h6eh?cluster=devnet) |
| a_resolver_lock | [3nyeSRUL...](https://solscan.io/tx/3nyeSRUL35Sh5dsKvxPs1vD89T4ULhAGuupNQw9xLWy1hg74yFypvbYEkowAjo2jPMjKqWMLwRzuCrHjP4pYzTib?cluster=devnet) |
| a_resolver_resolve_outcome3_early | [4csz9bY9...](https://solscan.io/tx/4csz9bY9bHTs2CGP8Nq3HiUkU6Na8TtBbLjVCsJxhsazjqbNJr9RsvahbXkpPV6BJtGSVK8rgk2L8mgSmyjya34c?cluster=devnet) |
| b_set_creation_open_50pct | [bsYc7VpL...](https://solscan.io/tx/bsYc7VpLQACHCK18PtncNcxUZKM9az7jUKqEkXj94TmwNxJj7MLHS4ECmZTqerqNJqDQFyuEr3v9itVU1JaBBq2?cluster=devnet) |
| b_user_create_2_outcomes | [eAN9PbZW...](https://solscan.io/tx/eAN9PbZWFj7w5sgYRZHpS1C75hYKyNJBVomGBmvxrY4qRzPXQeCWyz6Pd5gzzsHK6XCcxDxMJBGq52onpmfgm3t?cluster=devnet) |
| b_bettor2_buy_no | [4CRteDpc...](https://solscan.io/tx/4CRteDpcmBRxrhcARpVw53AoG3SXYwhZvuiTCi3sptT7vMgZ8wEEsczGbtCTdcrvJ2P2gSXssifGPLF1TA4ZXnq6?cluster=devnet) |
| b_set_creation_closed | [2iozVBXC...](https://solscan.io/tx/2iozVBXCLiUk3y8CcXBMpLHBUfmXfgEWDDoKd3CGfkEBMprhQscJnHrekhjCfgdFCqDAsxP7MmQf7rVpcwWQr3RX?cluster=devnet) |
| b_resolver_lock | [ehTak758...](https://solscan.io/tx/ehTak758rZwRkwW4QZ4Dgy2j9y27pUHX7mrYCX1iUgh5CU9dPc58UpXyVWY3F6f5MoygNceTkBR69ojdD5W8yD5?cluster=devnet) |
| b_resolver_resolve_yes_early | [2umZozLN...](https://solscan.io/tx/2umZozLNeXt3Jji4JZQdVPua7RdjFugKEtYUpvsmUaEC46C6PFqcPiz6JkFEyavAFCH5uiAzbE4PvUtyBrSUdMY9?cluster=devnet) |
| a_auto_pay_7TPu | [4zytixEq...](https://solscan.io/tx/4zytixEq1Z87ZMeM22fG4nE2YSyvsj351RnvgcHUCDGgP8H6DGJuhToNFffb7tRFksT2iKktjcUtYEtw6o3ZfACJ?cluster=devnet) |
| a_auto_pay_HvVa | [4KNqujrH...](https://solscan.io/tx/4KNqujrH7rvKHWY1qraBuab87QuNwy32jRC54oZwEMV8izyBqYqV3apsSQUCZQNGk2TZ4z23m2Tv1u18v7LL7qnH?cluster=devnet) |
| a_auto_pay_Eddh | [pLpX1Nwu...](https://solscan.io/tx/pLpX1NwuQZowYzb4CKU6n3bJuQ6qH7zbHhkzN7fynotSUJ6vd8z6BDE71qPCoYhZkxepvMGUH5j5okvR3tvgwCd?cluster=devnet) |
| a_collect_fees | [547V9fmW...](https://solscan.io/tx/547V9fmW824qVFdbhiQiX7LMhtX2UoHQ1yvCUfniYxL9sMEyWM9rzbPfo3k1jBzHEzn6uCWBp7DzFs6feB63ZL5m?cluster=devnet) |
| b_auto_pay_HvVa | [2rRpTAJZ...](https://solscan.io/tx/2rRpTAJZo1Zi5n58JuL9pncB5zbpzPWCRa4Uw9BgXxqfMvLrSoLZTMbFQ6PxjKesuQo6VboyE7zbBtR2SUbfWJQ7?cluster=devnet) |
| b_auto_pay_Eddh | [3zsBFtFr...](https://solscan.io/tx/3zsBFtFrdQTw15f6tht4FUBCSeLVVd7WzBpbQU5bF7gZQJphfzEpfCYLZvLtw2PTjYDDTP8MfSHMDPHPeaQjG71L?cluster=devnet) |
| b_collect_fees | [2aebvp18...](https://solscan.io/tx/2aebvp18hfHcfM2iCSXfBAydj7Lf6X5FTgD27Cm4LfUDrxDumngPo14NtiKEQNLTNzhtm6FD7JF8qcGnwVQqvjGS?cluster=devnet) |
| b_creator_fee_paid | [5vbujJbW...](https://solscan.io/tx/5vbujJbWWH675888CCx6YryQ672oHFXUH87BTJkDcUqCJwaP6J1pTA5xSfGMVRRfUgZsGPnrvjupAng3r5ywoXfV?cluster=devnet) |

| Must fail | Expected | Result | Signature |
|---|---|---|---|
| a_buy_outcome4 | BadSide | failed as expected | [64ojUeSa...](https://solscan.io/tx/64ojUeSaKLGHSNGfy3yikkDCneEdodyEYwgB6xaFjXpCFR8b89MbDaQRiyd24dmJbx8WpJsRxYnKovaeegBkhcp6?cluster=devnet) |
| b_creator_fee_to_wrong_wallet | ConstraintTokenOwner | failed as expected | [2GpQMjHU...](https://solscan.io/tx/2GpQMjHUmCUn9nqbDySURWG35sYC39sS25bRRRUgNy1QU8qH64NzYo9uYUg5mTae5mP6dnmfcg4h57nZ1GJ6f4Xt?cluster=devnet) |
